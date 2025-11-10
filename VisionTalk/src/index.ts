import { AppServer, AppSession, PhotoData } from "@mentra/sdk";
import * as express from "express";
import * as ejs from "ejs";
import * as path from "path";
import * as crypto from "crypto";

// Load environment variables from .env file
import { ENV, getServerUrl } from './config'
import { vtLog, shouldLog } from './log'
import { Message, StoredPhoto, UserState, VoiceConfig } from './types'
import { speakWithEvent, playTTSInChunks } from './services/tts'
import { requestPhotoRobust } from './services/camera'
import { cachePhoto, getLatestPhoto } from './services/photos'
import { analyzeImageWithGPT4V as analyzeImageService } from './services/openai'

/* ─────────────────────────────── Env Checks ─────────────────────────────── */
function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (!v) {
    console.warn(`[VisionTalk] Warning: Env var ${name} is missing.` + (fallback ? ` Using fallback.` : ` Server will run but related features may fail.`));
    return fallback ?? `missing_${name}`;
  }
  return v;
}

const PACKAGE_NAME = ENV.PACKAGE_NAME;
const MENTRAOS_API_KEY = ENV.MENTRAOS_API_KEY;
const OPENAI_API_KEY = ENV.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = ENV.ELEVENLABS_API_KEY;
const PORT = ENV.PORT;
const CAPTURE_ONLY = ENV.CAPTURE_ONLY;
const VT_LOG_LEVEL = ENV.VT_LOG_LEVEL; // error|warn|info|debug|silent
const VT_HTTP_LOG = ENV.VT_HTTP_LOG; // none|basic|sampled
const VT_HTTP_SAMPLE_RATE = ENV.VT_HTTP_SAMPLE_RATE;
const STARTUP_CHIME = ENV.STARTUP_CHIME;
const AUDIO_DUPLICATE_SUPPRESS_MS = ENV.AUDIO_DUPLICATE_SUPPRESS_MS;

/* ────────────────────────────── Main App Class ───────────────────────────── */
class VisionTalkMentraApp extends AppServer {
  private static readonly DEMO_USER_ID = "demo";

  private photos: Map<string, StoredPhoto> = new Map();
  // Maintain a short history (carousel) per user
  private photoHistory: Map<string, StoredPhoto[]> = new Map();
  private latestPhotoTimestamp: Map<string, number> = new Map();
  private isProcessing: boolean = false;
  // New per-user state map (supersedes demo-only logic incrementally)
  private userState: Map<string, UserState> = new Map();
  // Use protected name to avoid clashing with any private fields in base class
  private _vtActiveSessions: number = 0;
  // Basic stats for diagnostics/metrics
  private stats = {
    photosCaptured: 0,
    latestCaptureTime: null as Date | null,
    latestPhotoRequestServed: 0,
    startedAt: new Date(),
  };
  // Pipeline event timeline (ring buffer)
  private events: { ts: number; stage: string; detail?: any; error?: string }[] = [];
  private readonly MAX_EVENTS = 200;
  private readonly MAX_PHOTO_HISTORY = 10;
  private welcomePlayed: boolean = false;
  private shuttingDown: boolean = false;
  private startupSpeakDebounceUntil: number = 0;
  private lastTTSHash: string | null = null;
  private lastTTSAt: number = 0;

  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
    this.setupWebviewRoutes();
  }

  /* ────────────────────────── Session Lifecycle ─────────────────────────── */
  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    vtLog('info', `Session started for user ${userId}`)
    
    const state = this.ensureUserState(userId)
    
    // Subscribe to button press ONCE
    const offButton = session.events.onButtonPress(async ({ pressType }) => {
      vtLog('info', 'Button press event received', { pressType, captureOnly: CAPTURE_ONLY })
      
      if (pressType !== 'short') return
      if (state.isProcessing) {
        vtLog('warn', 'Capture already in progress, ignoring button press')
        return
      }
      
      state.isProcessing = true
      try {
        if (CAPTURE_ONLY) {
          await this.handleCaptureOnly(session, userId, state)
        } else {
          await this.handlePhotoAndAnalysis(session, userId, state)
        }
      } catch (err: any) {
        vtLog('error', 'Pipeline error', { error: String(err) })
        await speakWithEvent(session, 'Sorry, something went wrong.', this.recordEvent.bind(this))
      } finally {
        state.isProcessing = false
      }
    })

    // CRITICAL FIX: Only play welcome ONCE
    // Check if already played AND if debounce window has passed
    const now = Date.now()
    if (!state.welcomePlayed && (!state.startupDebounceUntil || now >= state.startupDebounceUntil)) {
      state.welcomePlayed = true
      state.startupDebounceUntil = now + AUDIO_DUPLICATE_SUPPRESS_MS

      // Play chime OR welcome TTS, not both
      if (STARTUP_CHIME) {
        const chimeUrl = `${getServerUrl()}/assets/chime-sound.mp3`
        try {
          await session.audio.playAudio({ audioUrl: chimeUrl, volume: 0.6 })
        } catch (e) {
          vtLog('warn', 'Chime playback failed', { error: String(e) })
        }
      } else {
        // Only speak if no chime
        await speakWithEvent(session, 'VisionTalk ready.', this.recordEvent.bind(this))
      }
    }

    this.addCleanupHandler(offButton)
  }

  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string
  ): Promise<void> {
    this.shuttingDown = true;
    vtLog('info', `Session stopped for user ${userId}`, { reason });
    this.isProcessing = false;
  this._vtActiveSessions = Math.max(0, this._vtActiveSessions - 1);
  }

  /* ──────────────────────────── Core Analysis Flow ───────────────────────────── */
  // FIXED signature: (session, userId, state)
  private async handlePhotoAndAnalysis(session: AppSession, userId: string, state: UserState) {
    this.recordEvent('capture_init');

    // 1) TTS prompt
    await speakWithEvent(session, "Stay still while I capture the image.", undefined, this.recordEvent.bind(this), state, 'tts_capture_prompt');

    // 2) Short delay + capability check + photo
    await sleep(250)
    this.recordEvent('photo_request')
    if (!session.capabilities?.hasCamera) {
      await speakWithEvent(session, 'Camera not available on this device.', undefined, this.recordEvent.bind(this), state, 'tts_no_camera')
      return
    }
    const photo = await requestPhotoRobust(session, this.recordEvent.bind(this), { attempts: 3, initialTimeoutMs: 20000, backoffMs: 750 })
    this.recordEvent('photo_received', { requestId: photo.requestId, size: photo.size, mimeType: photo.mimeType })
    vtLog('debug', `Photo captured`, { ts: (photo.timestamp || new Date()).toISOString(), req: photo.requestId, size: photo.size })
    cachePhoto(photo as any, userId, state)

    // 3) Chime
    this.recordEvent('chime_play')
    await session.audio.playAudio({ audioUrl: getServerUrl() + "/assets/chime-sound.mp3", volume: 0.6 })
    this.recordEvent('chime_done')

    // 4) Analyzing TTS
    await speakWithEvent(session, "Analyzing what I see...", undefined, this.recordEvent.bind(this), state, 'tts_analyzing')

    // 5) Vision analysis (can be no-op until API wired)
    const analysis = await analyzeImageService(photo as any, this.recordEvent.bind(this))

    // 6) TTS chunks
    this.recordEvent('tts_sent_to_elevenlabs', { textExcerpt: (analysis || '').substring(0, 120) })
    await playTTSInChunks(session, analysis || 'I took a picture.', undefined, this.recordEvent.bind(this), state, 'tts')
    this.recordEvent('tts_played')
    this.recordEvent('pipeline_complete')
  }

  // Capture-only flow: take photo, cache it, optional chime, no AI, no TTS
  private async handleCaptureOnly(session: AppSession, userId: string, state: UserState) {
    this.recordEvent('capture_only_init')
    await sleep(150)
    this.recordEvent('photo_request')

    if (!session.capabilities?.hasCamera) {
      await speakWithEvent(session, 'Camera not available on this device.', undefined, this.recordEvent.bind(this), state, 'tts_no_camera')
      return
    }
    const photo = await requestPhotoRobust(session, this.recordEvent.bind(this), { attempts: 3, initialTimeoutMs: 20000, backoffMs: 750 })
    this.recordEvent('photo_received', { requestId: photo.requestId, size: photo.size, mimeType: photo.mimeType })
    cachePhoto(photo as any, userId, state)

    try {
      this.recordEvent('chime_play')
      await session.audio.playAudio({ audioUrl: getServerUrl() + "/assets/chime-sound.mp3", volume: 0.6 })
      this.recordEvent('chime_done')
    } catch (err) {
      this.recordEvent('chime_error', {}, (err as Error)?.message)
    }
    this.recordEvent('capture_only_complete')
  }

  /* GPT-4V analysis moved to services/openai.ts */

  /* ────────────────────────── Photo Caching & Web Routes ────────────────────────── */
  // Photo caching handled by services/photos.ts

  private ensureUserState(userId: string): UserState {
    let s = this.userState.get(userId)
    if (!s) {
      s = { isProcessing: false, photoHistory: [], welcomePlayed: false, startupDebounceUntil: 0, lastTTSHash: null, lastTTSAt: 0 }
      this.userState.set(userId, s)
    }
    return s
  }

  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();
    // Serve local static assets (chime, icons). Place files under /assets in repo root.
    try {
      app.use('/assets', express.static(path.join(process.cwd(), 'assets')));
    } catch (err) {
      // If static middleware fails for any reason, log and continue — chime will be unavailable until fixed.
      vtLog('warn', 'Failed to mount /assets static route', { error: String(err) });
    }
    const DEMO_USER_ID = VisionTalkMentraApp.DEMO_USER_ID;

    // Lightweight request logger for diagnostics (ngrok / Mentra connectivity)
    app.use((req: any, _res: any, next: any) => {
      try {
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString();
        const host = (req.headers['host'] || '').toString();
        const ua = (req.headers['user-agent'] || '').toString();
        const pathStr = req.path || req.url;
        if (VT_HTTP_LOG === 'none') {
          // no-op
        } else if (VT_HTTP_LOG === 'basic') {
          // Log only non-poll routes
          if (!['/api/latest-photo', '/api/events'].includes(pathStr)) {
            vtLog('info', `HTTP ${req.method} ${pathStr}`, { host, from: ip });
          }
        } else {
          // sampled
          if (['/api/latest-photo', '/api/events'].includes(pathStr)) {
            if (Math.random() < VT_HTTP_SAMPLE_RATE) {
              vtLog('info', `POLL ${req.method} ${pathStr}`, { host, from: ip });
            }
          } else {
            vtLog('info', `HTTP ${req.method} ${pathStr}`, { host, from: ip, ua });
          }
        }
      } catch {}
      next();
    });

    // Root & health endpoints for ngrok testing
    app.get('/', (req: any, res: any) => {
      res.json({
        service: 'VisionTalk',
        status: 'ok',
        packageName: PACKAGE_NAME,
        time: new Date().toISOString(),
        logLevel: VT_LOG_LEVEL,
      });
    });
    app.get('/health', (req: any, res: any) => {
      res.json({
        status: 'healthy',
        app: PACKAGE_NAME,
  activeSessions: this._vtActiveSessions,
        hasPhoto: !!this.photos.get(DEMO_USER_ID),
        processing: this.isProcessing,
        captureOnly: CAPTURE_ONLY,
        httpLog: VT_HTTP_LOG,
        httpSampleRate: VT_HTTP_SAMPLE_RATE,
        time: new Date().toISOString(),
      });
    });

    // MentraOS will POST to /webhook when the app is activated or events occur.
    // Provide a minimal handler so registration succeeds; expand later for richer event handling.
    app.post('/webhook', (req: any, res: any) => {
      try {
        const eventType = req.headers['x-mentra-event'] || 'unknown';
        let body: any = {};
        if (req.is('application/json')) body = req.body;
        console.log('[VisionTalk] Webhook received', { eventType, body });
        // Always acknowledge quickly (<1s) so Mentra doesn’t treat as failure.
        res.status(200).json({ ok: true, received: eventType });
      } catch (err) {
        console.error('[VisionTalk] Webhook error', err);
        res.status(500).json({ ok: false });
      }
    });

    // Latest photo metadata
    app.get("/api/latest-photo", (req: any, res: any) => {
      const photo = this.photos.get(DEMO_USER_ID);
      if (!photo) return res.status(404).json({ error: "No photo available" });
      // Simple ETag support for client-side caching / 304
      const etag = `"${photo.requestId}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
      res.setHeader('ETag', etag);
      this.stats.latestPhotoRequestServed += 1;
      res.json({
        requestId: photo.requestId,
        timestamp: photo.timestamp.getTime(),
        hasPhoto: true,
      });
    });

    // Photo list (carousel)
    app.get('/api/photos', (req: any, res: any) => {
      const history = this.photoHistory.get(DEMO_USER_ID) || [];
      res.json(history.map(p => ({
        requestId: p.requestId,
        timestamp: p.timestamp.getTime(),
        mimeType: p.mimeType,
        size: p.size,
        sha256: p.sha256,
      })).reverse()); // newest first
    });

    // Photo info by id (metadata only; no bytes)
    app.get('/api/photo-info/:requestId', (req: any, res: any) => {
      const history = this.photoHistory.get(DEMO_USER_ID) || [];
      const p = history.find(ph => ph.requestId === req.params.requestId);
      if (!p) return res.status(404).json({ error: 'Not found' });
      res.json({
        requestId: p.requestId,
        timestamp: p.timestamp.getTime(),
        mimeType: p.mimeType,
        size: p.size,
        sha256: p.sha256,
        filename: p.filename,
        userId: p.userId,
      });
    });

    // Raw photo bytes
    app.get("/api/photo/:requestId", (req: any, res: any) => {
      const photo = this.photos.get(DEMO_USER_ID);
      if (!photo || photo.requestId !== req.params.requestId)
        return res.status(404).json({ error: "Photo not found" });
      res.set({ "Content-Type": photo.mimeType, "Cache-Control": "no-cache" });
      res.send(photo.buffer);
    });

    // Simple webview to preview photos
    app.get("/webview", async (req: any, res: any) => {
      const template = path.join(process.cwd(), "views", "photo-viewer.ejs");
      const html = await ejs.renderFile(template, {});
      res.send(html);
    });

    // Redacted env debug endpoint (for remote diagnostics)
    app.get('/debug/env', (req: any, res: any) => {
      res.json({
        PACKAGE_NAME,
        PUBLIC_URL: process.env.PUBLIC_URL,
        PORT,
        VT_LOG_LEVEL,
        VT_HTTP_LOG,
        VT_HTTP_SAMPLE_RATE,
        MENTRAOS_API_KEY: MENTRAOS_API_KEY ? 'present' : 'missing',
        OPENAI_API_KEY: OPENAI_API_KEY ? 'present' : 'missing',
        ELEVENLABS_API_KEY: ELEVENLABS_API_KEY ? 'present' : 'missing',
        time: new Date().toISOString(),
      });
    });

    // Lightweight metrics endpoint (no auth – suitable for dev ngrok only)
    app.get('/metrics', (req: any, res: any) => {
      res.json({
        activeSessions: this._vtActiveSessions,
        processing: this.isProcessing,
        photosCaptured: this.stats.photosCaptured,
        latestCaptureTime: this.stats.latestCaptureTime?.toISOString() || null,
        latestPhotoRequestServed: this.stats.latestPhotoRequestServed,
        uptimeSeconds: Math.floor((Date.now() - this.stats.startedAt.getTime()) / 1000),
        eventsStored: this.events.length,
        packageName: PACKAGE_NAME,
        time: new Date().toISOString(),
      });
    });

    // Event timeline
    app.get('/api/events', (req: any, res: any) => {
      res.json({ events: this.events.slice(-100) }); // cap response size
    });

    // Internal state snapshot for debugging button presses & photo cache
    app.get('/api/state', (req: any, res: any) => {
      const photo = this.photos.get(DEMO_USER_ID);
      const history = this.photoHistory.get(DEMO_USER_ID) || [];
      res.json({
        activeSessions: this._vtActiveSessions,
        processing: this.isProcessing,
        hasPhoto: !!photo,
        latestPhoto: photo ? {
          requestId: photo.requestId,
          ts: photo.timestamp.toISOString(),
          size: photo.size,
          mimeType: photo.mimeType,
          sha256: photo.sha256,
        } : null,
        historyCount: history.length,
        lastEvents: this.events.slice(-10),
      });
    });
  }

  private recordEvent(stage: string, detail?: any, error?: string) {
    const ev = { ts: Date.now(), stage, detail, error };
    this.events.push(ev);
    if (this.events.length > this.MAX_EVENTS) this.events.shift();
  }

  // tiny sleep helper (module scope below)
  }

function sleep(ms: number) {
  return new Promise<void>(res => setTimeout(res, ms))
}


/* ──────────────────────────────── Boot ──────────────────────────────────── */
const app = new VisionTalkMentraApp();
app.start().then(() => {
  console.log('[VisionTalk] Server started');
  console.log(`[VisionTalk] Local URL: http://localhost:${PORT}`);
  if (process.env.PUBLIC_URL) {
    console.log(`[VisionTalk] Public URL: ${process.env.PUBLIC_URL}`);
  } else {
    console.log('[VisionTalk] PUBLIC_URL not set – set this to your ngrok/static domain for MentraOS.');
  }
  console.log('[VisionTalk] Env summary:', {
    PACKAGE_NAME,
    MENTRAOS_API_KEY: MENTRAOS_API_KEY ? 'present' : 'missing',
    OPENAI_API_KEY: OPENAI_API_KEY ? 'present' : 'missing',
    ELEVENLABS_API_KEY: ELEVENLABS_API_KEY ? 'present' : 'missing',
  });
  console.log('[VisionTalk] Health endpoint: GET /health');
}).catch((err) => console.error(err));