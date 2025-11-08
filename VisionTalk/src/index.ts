import { AppServer, AppSession, ViewType, PhotoData } from "@mentra/sdk";
import { Request, Response } from "express";
import * as ejs from "ejs";
import * as path from "path";
import * as dotenv from "dotenv";

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
}

type Message = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
};

/* ─────────────────────────────── Env Checks ─────────────────────────────── */
const PACKAGE_NAME =
  process.env.PACKAGE_NAME ??
  (() => {
    throw new Error("PACKAGE_NAME is not set in .env file");
  })();
const MENTRAOS_API_KEY =
  process.env.MENTRAOS_API_KEY ??
  (() => {
    throw new Error("MENTRAOS_API_KEY is not set in .env file");
  })();
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ??
  (() => {
    throw new Error("OPENAI_API_KEY is not set in .env file");
  })();
const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY ??
  (() => {
    throw new Error("ELEVENLABS_API_KEY is not set in .env file");
  })();
const PORT = parseInt(process.env.PORT || "3000", 10);

/* ────────────────────────────── Main App Class ───────────────────────────── */
class VisionTalkMentraApp extends AppServer {
  private static readonly DEMO_USER_ID = "demo";

  private photos: Map<string, StoredPhoto> = new Map();
  private latestPhotoTimestamp: Map<string, number> = new Map();
  private isProcessing: boolean = false;

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
    // Force demo user for now
    userId = VisionTalkMentraApp.DEMO_USER_ID;
    this.logger.info(`VisionTalk session started for user ${userId}`);

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
    await session.audio.speak(
      "VisionTalk ready. Look at anything you want to understand, then press the button to take a photo. I'll analyze what I see and explain it to you.",
      voiceConfig
    );

    // Handle button presses
    session.events.onButtonPress(async ({ pressType }) => {
      if (pressType === "long") {
        this.logger.info("Long press detected - resetting session");
        await session.audio.speak("VisionTalk reset. Ready for your next question.", voiceConfig);
        return;
      }

      // Prevent multiple simultaneous requests
      if (this.isProcessing) {
        await session.audio.speak("Please wait, I'm still processing your last image.", voiceConfig);
        return;
      }

      this.isProcessing = true;
      
      try {
        await this.handlePhotoAndAnalysis(session, voiceConfig);
      } catch (error) {
        this.logger.error(`Error during photo analysis: ${error}`);
        await session.audio.speak(
          "Sorry, I encountered an error analyzing that image. Please try again.",
          voiceConfig
        );
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
    this.logger.info(`VisionTalk session stopped for user ${userId}. Reason: ${reason}`);
    this.isProcessing = false;
  }

  /* ──────────────────────────── Core Analysis Flow ───────────────────────────── */
  private async handlePhotoAndAnalysis(session: AppSession, voiceConfig: any) {
    // 1. Instruct user to stay still
    await session.audio.speak("Stay still while I capture the image.", voiceConfig);
    
    // 2. Take photo
    const photo = await session.camera.requestPhoto();
    this.logger.info(`Photo captured. ts=${photo.timestamp}`);
    this.cachePhoto(photo, VisionTalkMentraApp.DEMO_USER_ID);

    // 3. Play confirmation sound
    await session.audio.playAudio({
      audioUrl: "https://raw.githubusercontent.com/VictorChenCA/MentraLiveApp/main/assets/chime-sound.mp3",
      volume: 0.6,
    });

    // 4. Let user know we're processing
    await session.audio.speak("Analyzing what I see...", voiceConfig);

    // 5. Analyze with GPT-4V
    const analysis = await this.analyzeImageWithGPT4V(photo);
    
    // 6. Speak the analysis
    await session.audio.speak(analysis, voiceConfig);
  }

  /* ────────────────────────── GPT-4V Vision Analysis ─────────────────────────── */
  private async analyzeImageWithGPT4V(photo: PhotoData): Promise<string> {
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

    this.logger.info("[GPT-4V] Sending image analysis request");

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
      this.logger.error(`[GPT-4V] Error ${openaiRes.status} ${openaiRes.statusText}`);
      this.logger.error(`[GPT-4V] Body: ${errText}`);
      throw new Error(`OpenAI API error: ${openaiRes.status} ${openaiRes.statusText}`);
    }

    const json = await openaiRes.json();
    const analysis = json.choices?.[0]?.message?.content?.trim();

    if (!analysis) {
      throw new Error("No analysis received from GPT-4V");
    }

    this.logger.info(`[GPT-4V] Analysis complete: ${analysis.substring(0, 100)}...`);
    return analysis;
  }

  /* ────────────────────────── Photo Caching & Web Routes ────────────────────────── */
  private cachePhoto(photo: PhotoData, userId: string) {
    userId = VisionTalkMentraApp.DEMO_USER_ID;

    const cached: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
    };

    this.photos.set(userId, cached);
    this.latestPhotoTimestamp.set(userId, cached.timestamp.getTime());
    this.logger.debug(`Photo cached. user=${userId} ts=${cached.timestamp}`);
  }

  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();
    const DEMO_USER_ID = VisionTalkMentraApp.DEMO_USER_ID;

    // Latest photo metadata
    app.get("/api/latest-photo", (req: any, res: any) => {
      const photo = this.photos.get(DEMO_USER_ID);
      if (!photo) return res.status(404).json({ error: "No photo available" });
      res.json({
        requestId: photo.requestId,
        timestamp: photo.timestamp.getTime(),
        hasPhoto: true,
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
  }

  private getServerUrl(): string {
    const protocol = process.env.PUBLIC_URL?.startsWith("https") ? "https" : "http";
    return process.env.PUBLIC_URL || `${protocol}://localhost:${PORT}`;
  }
}

/* ──────────────────────────────── Boot ──────────────────────────────────── */
const app = new VisionTalkMentraApp();
app.start().catch((err) => console.error(err));