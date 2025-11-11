import { AppServer, AppSession, PhotoData } from "@mentra/sdk";
import * as express from "express";
import * as ejs from "ejs";
import * as path from "path";
import * as crypto from "crypto";

// Load environment variables from .env file
import { ENV, getServerUrl } from './config'
import { vtLog, shouldLog } from './log'
import { mountAudioDiagnostics } from './routes/audioDiagnostics'
import { Message, StoredPhoto, UserState, VoiceConfig } from './types'
import { speakWithEvent, playTTSInChunks } from './services/tts'
import { requestPhotoWithTimeout, requestPhotoRobust } from './services/camera'
import { cachePhoto, getLatestPhoto } from './services/photos'
import { produceCenterCrop } from './services/imageEnhance'
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
const CAPTURE_CHIME_ENABLED = ENV.CAPTURE_CHIME_ENABLED;
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
  // Track active AppSession per user for diagnostics and test endpoints
  private sessionsByUser: Map<string, AppSession> = new Map();

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
    this._vtActiveSessions += 1;
    
    const state = this.ensureUserState(userId)
  // Track session for debug/test endpoints
  this.sessionsByUser.set(userId, session)
    // Snapshot capabilities for diagnostics/routes
    try {
      state.capabilities = session.capabilities ?? state.capabilities;
      vtLog('info', 'Capabilities snapshot', {
        hasSpeaker: session.capabilities?.hasSpeaker,
        hasMicrophone: session.capabilities?.hasMicrophone,
        hasCamera: session.capabilities?.hasCamera,
        hasDisplay: session.capabilities?.hasDisplay,
        modelName: (session as any)?.capabilities?.modelName || 'unknown'
      });
    } catch {}
    const voiceConfig: VoiceConfig = {
      voice_id: "aYIHaVW2uuV2iGj07rJH",
      model_id: "eleven_flash_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.4, speed: 0.8 }
    }
    
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
          await this.handlePhotoAndAnalysis(session, voiceConfig, userId, state)
        }
      } catch (err: any) {
        vtLog('error', 'Pipeline error', { error: String(err) })
        await this.withAudioQueue(userId, () => speakWithEvent(session, 'Sorry, something went wrong.', voiceConfig, this.recordEvent.bind(this), state, 'tts_error'))
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
          await this.withAudioQueue(userId, () => session.audio.playAudio({ audioUrl: chimeUrl, volume: 0.6 }))
        } catch (e) {
          vtLog('warn', 'Chime playback failed', { error: String(e) })
        }
      } else {
        // Only speak if no chime
  const welcomeVoice: VoiceConfig = { voice_id: 'aYIHaVW2uuV2iGj07rJH', model_id: 'eleven_flash_v2_5' }
  await this.withAudioQueue(userId, () => speakWithEvent(session, 'VisionTalk ready.', welcomeVoice, this.recordEvent.bind(this), state, 'tts_welcome'))
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
    // Remove session from map
    this.sessionsByUser.delete(userId)
  }

  /* ──────────────────────────── Core Analysis Flow ───────────────────────────── */
  private async handlePhotoAndAnalysis(session: AppSession, voiceConfig: VoiceConfig, userId: string, state: UserState) {
    this.recordEvent('capture_init');
    // 1. Instruct user to stay still
  await this.withAudioQueue(userId, () => speakWithEvent(session, "Stay still while I capture the image.", voiceConfig, this.recordEvent.bind(this), state, 'tts_capture_prompt'))

    // 2. Take photo
    // Short delay after TTS to avoid racing hardware
    await sleep(250)
    this.recordEvent('photo_request')
    if (!session.capabilities?.hasCamera) {
      await speakWithEvent(session, 'Camera not available on this device.', voiceConfig, this.recordEvent.bind(this), state, 'tts_no_camera')
      return
    }
    const photo = await requestPhotoRobust(session, this.recordEvent.bind(this), { attempts: 3, initialTimeoutMs: 20000, backoffMs: 750, size: ENV.PHOTO_CAPTURE_SIZE as any })
    this.recordEvent('photo_received', { requestId: photo.requestId, size: photo.size, mimeType: photo.mimeType });
    vtLog('debug', `Photo captured`, { ts: photo.timestamp.toISOString(), req: photo.requestId, size: photo.size });
    const stored = await cachePhoto(photo, userId, state, this.recordEvent.bind(this));
    // Produce simple center crop (color preserved)
    try {
      const cc = await produceCenterCrop(photo, this.recordEvent.bind(this))
      stored.centerCroppedBuffer = cc.buffer
      stored.centerCropSteps = cc.steps
      this.recordEvent('photo_center_crop_cached', { requestId: photo.requestId, steps: cc.steps })
    } catch (err: any) {
      this.recordEvent('photo_center_crop_cache_error', {}, String(err))
    }

    // 3. Play confirmation sound (optional)
    if (CAPTURE_CHIME_ENABLED) {
      this.recordEvent('chime_play');
      await this.withAudioQueue(userId, () => session.audio.playAudio({ audioUrl: getServerUrl() + "/assets/chime-sound.mp3", volume: 0.6 }))
      this.recordEvent('chime_done');
    }

    // 4. Let user know we're processing
    await this.withAudioQueue(userId, () => speakWithEvent(session, "Analyzing what I see...", voiceConfig, this.recordEvent.bind(this), state, 'tts_analyzing'))

  // 5. Analyze with GPT-4V (service)
  const result = await analyzeImageService(photo, this.recordEvent.bind(this));
  const analysis = result.analysis;
  const answer = result.answer;
  // Persist full analysis and short answer for webview retrieval (latest and per-photo)
  state.latestAnalysis = analysis;
  state.latestAnswer = answer;
  state.latestAnalysisAt = Date.now();
  if (!state.analysisByRequestId) state.analysisByRequestId = {};
  state.analysisByRequestId[photo.requestId] = { text: analysis, answer, at: state.latestAnalysisAt };

    // 6. Send to ElevenLabs (TTS)
    const ttsText = (answer && answer.length < 600) ? answer : analysis;
    this.recordEvent('tts_sent_to_elevenlabs', { textExcerpt: ttsText.substring(0, 160), length: ttsText.length, requestId: photo.requestId, usedAnswer: !!answer });
    // Play TTS in manageable chunks to avoid long-request timeouts
    await this.withAudioQueue(userId, () => playTTSInChunks(session, ttsText, voiceConfig, this.recordEvent.bind(this), state))
    this.recordEvent('tts_played');
    this.recordEvent('pipeline_complete');
  }

  // Capture-only flow: take photo, cache it, optional chime, no AI, no TTS
  private async handleCaptureOnly(session: AppSession, userId: string, state: UserState) {
    this.recordEvent('capture_only_init');
    // Take photo directly without pre-TTS
    await sleep(150)
    this.recordEvent('photo_request')
    if (!session.capabilities?.hasCamera) {
      await speakWithEvent(session, 'Camera not available on this device.', { } as any, this.recordEvent.bind(this), state, 'tts_no_camera')
      return
    }
    const photo = await requestPhotoRobust(session, this.recordEvent.bind(this), { attempts: 3, initialTimeoutMs: 20000, backoffMs: 750, size: ENV.PHOTO_CAPTURE_SIZE as any })
    this.recordEvent('photo_received', { requestId: photo.requestId, size: photo.size, mimeType: photo.mimeType });
    const stored = await cachePhoto(photo, userId, state, this.recordEvent.bind(this));
    try {
      const cc = await produceCenterCrop(photo, this.recordEvent.bind(this))
      stored.centerCroppedBuffer = cc.buffer
      stored.centerCropSteps = cc.steps
      this.recordEvent('photo_center_crop_cached', { requestId: photo.requestId, steps: cc.steps })
    } catch (err: any) {
      this.recordEvent('photo_center_crop_cache_error', {}, String(err))
    }
    // Soft confirmation chime (optional)
    if (CAPTURE_CHIME_ENABLED) {
      try {
        this.recordEvent('chime_play');
        await this.withAudioQueue(userId, () => session.audio.playAudio({ audioUrl: getServerUrl() + "/assets/chime-sound.mp3", volume: 0.6 }))
        this.recordEvent('chime_done');
      } catch (err) {
        this.recordEvent('chime_error', {}, (err as Error)?.message);
      }
    }
    this.recordEvent('capture_only_complete');
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

  // Serialize audio for a user to prevent overlaps
  private async withAudioQueue<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const state = this.ensureUserState(userId)
    const prev = state.audioChain || Promise.resolve()
    let resolveNext: () => void
    const next = new Promise<void>(res => { resolveNext = res })
    state.audioChain = prev.then(() => next)
    try {
      this.recordEvent('audio_queue_enter', { userId })
      const result = await fn()
      // small tail to avoid cut-offs
      await new Promise(r => setTimeout(r, 100))
      return result
    } finally {
      this.recordEvent('audio_queue_exit', { userId })
      resolveNext!()
    }
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
      // compute across all users
      const users = Array.from(this.userState.keys());
      const anyPhoto = users.some(uid => (this.userState.get(uid)?.photoHistory.length || 0) > 0);
      const activeProcessingUsers = users.filter(uid => this.userState.get(uid)?.isProcessing).length;
      res.json({
        status: 'healthy',
        app: PACKAGE_NAME,
        activeSessions: this._vtActiveSessions,
        hasPhoto: anyPhoto,
        processing: activeProcessingUsers > 0,
        activeProcessingUsers,
        users,
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

    // Capabilities diagnostics (per-user snapshot)
    app.get('/api/capabilities', (req: any, res: any) => {
      const users: Record<string, any> = {};
      for (const [uid, st] of this.userState.entries()) {
        const caps = st.capabilities || {};
        users[uid] = {
          modelName: caps?.modelName ?? undefined,
          hasSpeaker: !!caps?.hasSpeaker,
          hasMicrophone: !!caps?.hasMicrophone,
          hasCamera: !!caps?.hasCamera,
          hasDisplay: !!caps?.hasDisplay,
          speaker: caps?.speaker ?? undefined,
          notes: !caps?.hasSpeaker ? 'No speaker reported; audio will route through phone by design.' : undefined,
        };
      }
      const summary = {
        users: Object.keys(users).length,
        withSpeaker: Object.values(users).filter((u: any) => u.hasSpeaker).length,
      };
      res.json({ summary, users });
    });

    // List active sessions
    app.get('/api/active-sessions', (req: any, res: any) => {
      const users = Array.from(this.sessionsByUser.keys());
      res.json({ count: users.length, users });
    });

    // Trigger an audio test on the active session for a user
    app.get('/api/audio-test', async (req: any, res: any) => {
      try {
        const queryUser = (req.query.userId as string) || null;
        const uid = queryUser || Array.from(this.sessionsByUser.keys())[0];
        if (!uid) return res.status(404).json({ error: 'No active sessions' });
        const session = this.sessionsByUser.get(uid);
        if (!session) return res.status(404).json({ error: `No session for user ${uid}` });
        const state = this.ensureUserState(uid);
        const volume = Math.min(Math.max(Number(req.query.volume ?? 1.0), 0), 1);
        const voiceConfig: VoiceConfig = { model_id: 'eleven_flash_v2_5' };

        this.recordEvent('audio_test_start', { userId: uid, volume });
        // Speak and chime to make the route obvious
        await this.withAudioQueue(uid, () => speakWithEvent(session, 'Audio test: one, two, three.', voiceConfig, this.recordEvent.bind(this), state, 'tts_audio_test'));
        await this.withAudioQueue(uid, () => session.audio.playAudio({ audioUrl: getServerUrl() + '/assets/chime-sound.mp3', volume }));
        this.recordEvent('audio_test_done', { userId: uid });
        res.json({ ok: true, userId: uid });
      } catch (err: any) {
        this.recordEvent('audio_test_error', {}, String(err));
        res.status(500).json({ ok: false, error: String(err) });
      }
    });

    // Mount audio diagnostics routes in separate module
    mountAudioDiagnostics({
      app,
      getActiveSessionUserIds: () => Array.from(this.sessionsByUser.keys()),
      getSession: (uid: string) => this.sessionsByUser.get(uid),
      ensureUserState: (uid: string) => this.ensureUserState(uid),
      withAudioQueue: (uid, fn) => this.withAudioQueue(uid, fn),
      recordEvent: this.recordEvent.bind(this),
      clearEvents: () => { this.events = [] },
    });

    // Stop any currently playing audio on a user session
    app.post('/api/stop-audio', async (req: any, res: any) => {
      try {
        const queryUser = (req.query.userId as string) || null;
        const uid = queryUser || Array.from(this.sessionsByUser.keys())[0];
        if (!uid) return res.status(404).json({ error: 'No active sessions' });
        const session = this.sessionsByUser.get(uid);
        if (!session) return res.status(404).json({ error: `No session for user ${uid}` });
        session.audio.stopAudio();
        res.json({ ok: true, userId: uid });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    });

    // Latest photo metadata (optionally filter by userId; otherwise choose latest across all users)
    app.get("/api/latest-photo", (req: any, res: any) => {
      const queryUser = (req.query.userId as string) || null;
      let latest: { photo: StoredPhoto; userId: string } | null = null;
      const users = queryUser ? [queryUser] : Array.from(this.userState.keys());
      for (const uid of users) {
        const state = this.userState.get(uid);
        if (!state || state.photoHistory.length === 0) continue;
        const p = state.photoHistory[state.photoHistory.length - 1];
        if (!latest || p.timestamp.getTime() > latest.photo.timestamp.getTime()) {
          latest = { photo: p, userId: uid };
        }
      }
      if (!latest) return res.status(404).json({ error: "No photo available" });
      const { photo, userId } = latest;
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
        userId,
        mimeType: photo.mimeType,
        size: photo.size,
      });
    });

    // Photo list (carousel) – optional userId filter, optional limit (default 50)
    app.get('/api/photos', (req: any, res: any) => {
      const queryUser = (req.query.userId as string) || null;
      const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);
      let items: Array<{ p: StoredPhoto; userId: string }> = [];
      const users = queryUser ? [queryUser] : Array.from(this.userState.keys());
      for (const uid of users) {
        const state = this.userState.get(uid);
        if (!state) continue;
        for (const p of state.photoHistory) {
          items.push({ p, userId: uid });
        }
      }
      // newest first across users
      items.sort((a, b) => b.p.timestamp.getTime() - a.p.timestamp.getTime());
      const resp = items.slice(0, limit).map(({ p, userId }) => ({
        requestId: p.requestId,
        timestamp: p.timestamp.getTime(),
        mimeType: p.mimeType,
        size: p.size,
        sha256: p.sha256,
        userId,
      }));
      res.json(resp);
    });

    // Photo info by id (metadata only; no bytes) – searches across all users
    app.get('/api/photo-info/:requestId', (req: any, res: any) => {
      const { requestId } = req.params;
      let found: { p: StoredPhoto; userId: string } | null = null;
      for (const [uid, state] of this.userState.entries()) {
        const p = state.photoHistory.find(ph => ph.requestId === requestId);
        if (p) { found = { p, userId: uid }; break; }
      }
      if (!found) return res.status(404).json({ error: 'Not found' });
      const { p, userId } = found;
      res.json({
        requestId: p.requestId,
        timestamp: p.timestamp.getTime(),
        mimeType: p.mimeType,
        size: p.size,
        sha256: p.sha256,
        filename: p.filename,
  centerCropped: !!p.centerCroppedBuffer,
  centerCropSteps: p.centerCropSteps,
        userId,
      });
    });

    // Raw photo bytes – searches across all users
    app.get("/api/photo/:requestId", (req: any, res: any) => {
      const { requestId } = req.params;
      let photo: StoredPhoto | null = null;
      for (const state of this.userState.values()) {
        const p = state.photoHistory.find(ph => ph.requestId === requestId);
        if (p) { photo = p; break; }
      }
      if (!photo) return res.status(404).json({ error: "Photo not found" });
      res.set({ "Content-Type": photo.mimeType, "Cache-Control": "no-cache" });
      res.send(photo.buffer);
    });

    // Center-cropped photo bytes – searches across all users
    app.get("/api/photo-center/:requestId", (req: any, res: any) => {
      const { requestId } = req.params;
      let photo: StoredPhoto | null = null;
      for (const state of this.userState.values()) {
        const p = state.photoHistory.find(ph => ph.requestId === requestId);
        if (p) { photo = p; break; }
      }
      if (!photo) return res.status(404).json({ error: "Photo not found" });
      if (!photo.centerCroppedBuffer) return res.status(404).json({ error: "Center-cropped photo not available" });
      res.set({ "Content-Type": photo.mimeType, "Cache-Control": "no-cache" });
      res.send(photo.centerCroppedBuffer);
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
      const totalPhotos = Array.from(this.userState.values()).reduce((acc, s) => acc + s.photoHistory.length, 0);
      const activeProcessingUsers = Array.from(this.userState.values()).filter(s => s.isProcessing).length;
      res.json({
        activeSessions: this._vtActiveSessions,
        processing: activeProcessingUsers > 0,
        activeProcessingUsers,
        usersCount: this.userState.size,
        totalPhotos,
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
    app.post('/api/events/clear', (req: any, res: any) => {
      this.events = [];
      res.json({ ok: true });
    });

    // Latest full analysis text (optionally per userId, else latest across users)
    app.get('/api/analysis/latest', (req: any, res: any) => {
      const queryUser = (req.query.userId as string) || null;
      let latest: { userId: string; analysis: string; at: number } | null = null;
      let latestAnswer: string | undefined;
      const users = queryUser ? [queryUser] : Array.from(this.userState.keys());
      for (const uid of users) {
        const st = this.userState.get(uid);
        if (!st?.latestAnalysis) continue;
        if (!latest || (st.latestAnalysisAt || 0) > latest.at) {
          latest = { userId: uid, analysis: st.latestAnalysis, at: st.latestAnalysisAt || 0 };
          latestAnswer = st.latestAnswer;
        }
      }
      if (!latest) return res.status(404).json({ error: 'No analysis available' });
      res.json({
        userId: latest.userId,
        analysis: latest.analysis,
        timestamp: latest.at,
        length: latest.analysis.length,
        answer: latestAnswer,
      });
    });

    // Full analysis for a specific photo requestId
    app.get('/api/analysis/by-request/:requestId', (req: any, res: any) => {
      const { requestId } = req.params;
      for (const [uid, st] of this.userState.entries()) {
        const map = st.analysisByRequestId || {};
        const entry = map[requestId];
        if (entry) {
          return res.json({ userId: uid, analysis: entry.text, answer: entry.answer, timestamp: entry.at, length: entry.text.length, requestId });
        }
      }
      return res.status(404).json({ error: 'No analysis for requestId' });
    });
    // Chunked analysis view (splits stored analysis using same splitter as TTS)
    app.get('/api/analysis/chunks/:requestId', (req: any, res: any) => {
      const { requestId } = req.params;
      let found: { userId: string; text: string; at: number } | null = null;
      for (const [uid, st] of this.userState.entries()) {
        const entry = st.analysisByRequestId?.[requestId];
        if (entry) { found = { userId: uid, text: entry.text, at: entry.at }; break; }
      }
      if (!found) return res.status(404).json({ error: 'No analysis for requestId' });
      // Lazy import to avoid circular dependency concerns
      import('./services/tts').then(mod => {
        const splitter = mod.splitIntoChunks;
        const chunks = splitter(found!.text, 450);
        res.json({ userId: found!.userId, requestId, timestamp: found!.at, length: found!.text.length, chunks, count: chunks.length });
      }).catch(err => {
        res.status(500).json({ error: 'Splitter error', detail: String(err) });
      });
    });

    // Internal state snapshot for debugging button presses & photo cache
    app.get('/api/state', (req: any, res: any) => {
      const users: Record<string, { latestPhoto?: any; historyCount: number; isProcessing: boolean }> = {};
      for (const [uid, state] of this.userState.entries()) {
        const latest = state.photoHistory[state.photoHistory.length - 1];
        users[uid] = {
          latestPhoto: latest ? {
            requestId: latest.requestId,
            ts: latest.timestamp.toISOString(),
            size: latest.size,
            mimeType: latest.mimeType,
            sha256: latest.sha256,
          } : undefined,
          historyCount: state.photoHistory.length,
          isProcessing: !!state.isProcessing,
        };
      }
      res.json({
        activeSessions: this._vtActiveSessions,
        users,
        usersCount: Object.keys(users).length,
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