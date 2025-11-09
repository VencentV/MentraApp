import { AppServer, AppSession, ViewType, PhotoData } from "@mentra/sdk";
import { Request, Response } from "express";
import * as ejs from "ejs";
import * as path from "path";
import * as dotenv from "dotenv";
import * as crypto from "crypto";

// Load environment variables from .env file
dotenv.config();

interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
  sha256?: string;
}

type Message = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
};

/* ─────────────────────────────── Env Checks ─────────────────────────────── */
function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (!v) {
    console.warn(`[VisionTalk] Warning: Env var ${name} is missing.` + (fallback ? ` Using fallback.` : ` Server will run but related features may fail.`));
    return fallback ?? `missing_${name}`;
  }
  return v;
}

const PACKAGE_NAME = requireEnv("PACKAGE_NAME", "com.visiontalk.assistant.dev");
const MENTRAOS_API_KEY = requireEnv("MENTRAOS_API_KEY");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const ELEVENLABS_API_KEY = requireEnv("ELEVENLABS_API_KEY");
const PORT = parseInt(process.env.PORT || "3000", 10);
const CAPTURE_ONLY = (process.env.CAPTURE_ONLY || "").toLowerCase() === "true";
const VT_LOG_LEVEL = (process.env.VT_LOG_LEVEL || 'info').toLowerCase(); // error|warn|info|debug|silent
const VT_HTTP_LOG = (process.env.VT_HTTP_LOG || 'sampled').toLowerCase(); // none|basic|sampled
const VT_HTTP_SAMPLE_RATE = Math.max(0, Math.min(1, parseFloat(process.env.VT_HTTP_SAMPLE_RATE || '0.033')));

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
const levelOrder: Record<LogLevel, number> = { silent: 99, error: 0, warn: 1, info: 2, debug: 3 };
function shouldLog(level: LogLevel) {
  return levelOrder[level] <= levelOrder[(VT_LOG_LEVEL as LogLevel) in levelOrder ? (VT_LOG_LEVEL as LogLevel) : 'info'];
}
function vtLog(level: LogLevel, msg: string, meta?: any) {
  if (!shouldLog(level)) return;
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  if (level === 'error') return console.error('[VisionTalk]', line);
  if (level === 'warn') return console.warn('[VisionTalk]', line);
  return console.log('[VisionTalk]', line);
}

/* ────────────────────────────── Main App Class ───────────────────────────── */
class VisionTalkMentraApp extends AppServer {
  private static readonly DEMO_USER_ID = "demo";

  private photos: Map<string, StoredPhoto> = new Map();
  // Maintain a short history (carousel) per user
  private photoHistory: Map<string, StoredPhoto[]> = new Map();
  private latestPhotoTimestamp: Map<string, number> = new Map();
  private isProcessing: boolean = false;
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
  this._vtActiveSessions = Math.max(0, this._vtActiveSessions + 1);
    // Force demo user for now
    userId = VisionTalkMentraApp.DEMO_USER_ID;
  vtLog('info', `Session started for user ${userId}`);

    if (CAPTURE_ONLY) vtLog('info', 'CAPTURE_ONLY mode enabled – skipping TTS and OpenAI.');

    // Voice configuration for natural, clear speech
    const voiceConfig = {
      voice_id: "WdZjiN0nNcik2LBjOHiv", // David Attenborough voice
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.4,
        speed: 0.9,
      },
    };

    // Welcome the user
    if (!CAPTURE_ONLY) {
      await session.audio.speak(
        "VisionTalk ready. Look at anything you want to understand, then press the button to take a photo. I'll analyze what I see and explain it to you.",
        voiceConfig
      );
    }

    // Handle button presses
    session.events.onButtonPress(async ({ pressType }) => {
      if (pressType === "long") {
        this.logger.info("Long press detected - resetting session");
        await session.audio.speak("VisionTalk reset. Ready for your next question.", voiceConfig);
        return;
      }

      // Prevent multiple simultaneous requests
      if (this.isProcessing) {
        if (!CAPTURE_ONLY) {
          await session.audio.speak("Please wait, I'm still processing your last image.", voiceConfig);
        }
        return;
      }

      this.isProcessing = true;
      
      try {
        if (CAPTURE_ONLY) {
          await this.handleCaptureOnly(session);
        } else {
          await this.handlePhotoAndAnalysis(session, voiceConfig);
        }
      } catch (error) {
  vtLog('warn', `Error during photo processing`, { error: String(error) });
        if (!CAPTURE_ONLY) {
          await session.audio.speak(
            "Sorry, I encountered an error analyzing that image. Please try again.",
            voiceConfig
          );
        }
      } finally {
        this.isProcessing = false;
      }
    });
  }

  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string
  ): Promise<void> {
    userId = VisionTalkMentraApp.DEMO_USER_ID;
    vtLog('info', `Session stopped for user ${userId}`, { reason });
    this.isProcessing = false;
  this._vtActiveSessions = Math.max(0, this._vtActiveSessions - 1);
  }

  /* ──────────────────────────── Core Analysis Flow ───────────────────────────── */
  private async handlePhotoAndAnalysis(session: AppSession, voiceConfig: any) {
    this.recordEvent('capture_init');
    // 1. Instruct user to stay still
    await this.speakWithEvent(session, "Stay still while I capture the image.", voiceConfig, 'tts_capture_prompt');
    
    // 2. Take photo
    this.recordEvent('photo_request');
    const photo = await session.camera.requestPhoto();
    this.recordEvent('photo_received', { requestId: photo.requestId, size: photo.size, mimeType: photo.mimeType });
  vtLog('debug', `Photo captured`, { ts: photo.timestamp.toISOString(), req: photo.requestId, size: photo.size });
    this.cachePhoto(photo, VisionTalkMentraApp.DEMO_USER_ID);

    // 3. Play confirmation sound
    this.recordEvent('chime_play');
    await session.audio.playAudio({
      audioUrl: "https://raw.githubusercontent.com/VictorChenCA/MentraLiveApp/main/assets/chime-sound.mp3",
      volume: 0.6,
    });
    this.recordEvent('chime_done');

    // 4. Let user know we're processing
    await this.speakWithEvent(session, "Analyzing what I see...", voiceConfig, 'tts_analyzing');

    // 5. Analyze with GPT-4V
    const analysis = await this.analyzeImageWithGPT4V(photo);
    
    // 6. Speak the analysis
    await this.speakWithEvent(session, analysis, voiceConfig, 'tts_analysis');
    this.recordEvent('pipeline_complete');
  }

  // Capture-only flow: take photo, cache it, optional chime, no AI, no TTS
  private async handleCaptureOnly(session: AppSession) {
    this.recordEvent('capture_only_init');
    // Take photo directly without pre-TTS
    this.recordEvent('photo_request');
    const photo = await session.camera.requestPhoto();
    this.recordEvent('photo_received', { requestId: photo.requestId, size: photo.size, mimeType: photo.mimeType });
    this.cachePhoto(photo, VisionTalkMentraApp.DEMO_USER_ID);
    // Soft confirmation chime
    try {
      this.recordEvent('chime_play');
      await session.audio.playAudio({
        audioUrl: "https://raw.githubusercontent.com/VictorChenCA/MentraLiveApp/main/assets/chime-sound.mp3",
        volume: 0.6,
      });
      this.recordEvent('chime_done');
    } catch (err) {
      this.recordEvent('chime_error', {}, (err as Error)?.message);
    }
    this.recordEvent('capture_only_complete');
  }

  /* ────────────────────────── GPT-4V Vision Analysis ─────────────────────────── */
  private async analyzeImageWithGPT4V(photo: PhotoData): Promise<string> {
    this.recordEvent('openai_request_init');
    // Convert photo to base64 for OpenAI API
    const base64Image = photo.buffer.toString('base64');
    const imageUrl = `data:${photo.mimeType};base64,${base64Image}`;

    const messages: Message[] = [
      {
        role: "system",
        content: "You are VisionTalk, an AI assistant that helps people understand what they're looking at through smart glasses. " +
          "When shown an image, provide a clear, helpful explanation of what you see. " +
          "Focus on being informative and conversational. " +
          "If it's text (like homework, signs, documents), read and explain it. " +
          "If it's an object or scene, describe it and provide relevant context or advice. " +
          "If it's something technical, explain how it works or how to use it. " +
          "Keep responses concise but thorough - aim for 30-60 seconds of speaking time. " +
          "Be friendly and educational."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "What do you see in this image? Please analyze it and explain what's happening, what it means, or how I might use this information."
          },
          {
            type: "image_url",
            image_url: {
              url: imageUrl
            }
          }
        ]
      }
    ];

    const openaiPayload = {
      model: "gpt-4o", // Using GPT-4 with vision capabilities
      messages: messages,
      max_tokens: 300, // Limit response length for audio delivery
      temperature: 0.7, // Balanced creativity and consistency
    };

  vtLog('debug', "[GPT-4V] Sending image analysis request");
  this.recordEvent('openai_request_sent');

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openaiPayload),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
  vtLog('warn', `[GPT-4V] Error ${openaiRes.status} ${openaiRes.statusText}`);
  if (shouldLog('debug')) vtLog('debug', `[GPT-4V] Body: ${errText}`);
      this.recordEvent('openai_error', { status: openaiRes.status, statusText: openaiRes.statusText, body: errText });
      throw new Error(`OpenAI API error: ${openaiRes.status} ${openaiRes.statusText}`);
    }

  const json = (await openaiRes.json()) as any;
  const analysis = json.choices?.[0]?.message?.content?.trim();

    if (!analysis) {
      this.recordEvent('openai_empty_response');
      throw new Error("No analysis received from GPT-4V");
    }

    vtLog('debug', `[GPT-4V] Analysis complete: ${analysis.substring(0, 100)}...`);
    this.recordEvent('openai_response_ok', { excerpt: analysis.substring(0,120) });
    return analysis;
  }

  /* ────────────────────────── Photo Caching & Web Routes ────────────────────────── */
  private cachePhoto(photo: PhotoData, userId: string) {
    userId = VisionTalkMentraApp.DEMO_USER_ID;

    // Compute a quick integrity hash (helps confirm unique device captures)
    const sha256 = crypto.createHash('sha256').update(photo.buffer).digest('hex');
    
    const cached: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
      sha256,
    };

    this.photos.set(userId, cached);
    const history = this.photoHistory.get(userId) || [];
    history.push(cached);
    if (history.length > this.MAX_PHOTO_HISTORY) history.shift();
    this.photoHistory.set(userId, history);
    this.latestPhotoTimestamp.set(userId, cached.timestamp.getTime());
  if (shouldLog('debug')) vtLog('debug', `Photo cached`, { userId, ts: cached.timestamp.toISOString() });
    // Update metrics
    this.stats.photosCaptured += 1;
    this.stats.latestCaptureTime = cached.timestamp;
    this.recordEvent('photo_cached', { requestId: photo.requestId });
  }

  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();
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

  private async speakWithEvent(session: AppSession, text: string, voiceConfig: any, stage: string) {
    this.recordEvent(stage + '_start', { textExcerpt: text.substring(0,120) });
    try {
      await session.audio.speak(text, voiceConfig);
      this.recordEvent(stage + '_done');
    } catch (err: any) {
      this.recordEvent(stage + '_error', {}, err?.message || String(err));
      throw err;
    }
  }

  private getServerUrl(): string {
    const protocol = process.env.PUBLIC_URL?.startsWith("https") ? "https" : "http";
    return process.env.PUBLIC_URL || `${protocol}://localhost:${PORT}`;
  }
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