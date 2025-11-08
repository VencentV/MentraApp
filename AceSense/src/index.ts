import { AppServer, AppSession, ViewType, PhotoData } from "@mentra/sdk";
import { Request, Response } from "express";
import * as ejs from "ejs";
import * as path from "path";

interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
}

type Stage =
  | "hole"
  | "flop"
  | "turn"
  | "river"
  | "await_hole_photo"
  | "await_flop_photo"
  | "await_turn_photo"
  | "await_river_photo";

interface PlayerState {
  stage: Stage;
  hole: string[];
  board: string[];
}

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
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
const ROBOFLOW_API_KEY =
  process.env.ROBOFLOW_API_KEY ??
  (() => {
    throw new Error("ROBOFLOW_API_KEY is not set in .env file");
  })();
const PORT = parseInt(process.env.PORT || "3000", 10);

/* ────────────────────────────── Main App Class ───────────────────────────── */
class PokerCoachMentraApp extends AppServer {
  private static readonly DEMO_USER_ID = "demo";

  // Use a single global state object for the demo user
  private globalState: {
    stage: Stage;
    hole: string[];
    board: string[];
  } = {
    stage: "hole",
    hole: [],
    board: [],
  };

  private photos: Map<string, StoredPhoto> = new Map();
  private latestPhotoTimestamp: Map<string, number> = new Map();

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
    userId = PokerCoachMentraApp.DEMO_USER_ID;
    this.logger.info(`Session started for user ${userId}`);
    this.resetGlobalState();

    const ops = {
      voice_id: "WdZjiN0nNcik2LBjOHiv",
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.85,
        style: 0.6,
        speed: 0.95,
      },
    };

    session.events.onButtonPress(async ({ pressType }) => {
      if (pressType == "long") {
        this.logger.warn(`Long press detected - resetting state.`);
        this.resetGlobalState();
      }

      this.logger.info(`Button pressed. Current stage: ${this.globalState.stage}`);

      // Always stop any ongoing audio first
      await session.audio.stopAudio();

      try {
        switch (this.globalState.stage) {
          case "hole":
            await session.audio.speak(
              "Ready. Show me your hand and press the button again to take a photo.",
              ops
            );
            this.globalState.stage = "await_hole_photo";
            break;

          case "await_hole_photo":
            await this.handlePhotoStage(session, "hole");
            break;

          case "flop":
            await session.audio.speak(
              "Show me the flop. Press again to take a photo.",
              ops
            );
            this.globalState.stage = "await_flop_photo";
            break;

          case "await_flop_photo":
            await this.handlePhotoStage(session, "flop");
            break;

          case "turn":
            await session.audio.speak(
              "Show me the turn. Press again to take a photo.",
              ops
            );
            this.globalState.stage = "await_turn_photo";
            break;

          case "await_turn_photo":
            await this.handlePhotoStage(session, "turn");
            break;

          case "river":
            await session.audio.speak(
              "Show me the river. Press again to take a photo.",
              ops
            );
            this.globalState.stage = "await_river_photo";
            break;

          case "await_river_photo":
            await this.handlePhotoStage(session, "river");
            break;

          default:
            this.logger.warn(
              `Unknown stage "${this.globalState.stage}" – resetting state.`,
              ops
            );
            this.resetGlobalState();
        }
      } catch (err) {
        this.logger.error(`Error during stage ${this.globalState.stage}: ${err}`);
        await session.audio.speak(
          "Sorry, there was an error analyzing your hand.",
          ops
        );
        this.resetGlobalState();
      }
    });
  }

  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string
  ): Promise<void> {
    userId = PokerCoachMentraApp.DEMO_USER_ID;
    this.logger.info(`Session stopped for user ${userId}. Reason: ${reason}`);
    this.resetGlobalState();
  }

  private resetGlobalState() {
    this.globalState = { stage: "hole", hole: [], board: [] };
  }

  /* ──────────────────────────── Stage Helpers ───────────────────────────── */
  private async handlePhotoStage(
    session: AppSession,
    stage: "hole" | "flop" | "turn" | "river"
  ) {

    // TODO: TRY KARAN'S CODE:
    const ops = {
      voice_id: "WdZjiN0nNcik2LBjOHiv",
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.85,
        style: 0.6,
        speed: 0.95,
      },
    };

    // 1. Output 'stay still' message:
    await session.audio.speak("Stay still.", ops);
    
    // 2. Take (i.e. capture) photo:
    const photo = await session.camera.requestPhoto();
    this.logger.info(
      `Photo captured for stage ${stage}. ts=${photo.timestamp}`
    );
    this.cachePhoto(photo, PokerCoachMentraApp.DEMO_USER_ID);

    await session.audio.playAudio({
      audioUrl:
        "https://raw.githubusercontent.com/VictorChenCA/MentraLiveApp/main/assets/chime-sound.mp3",
      volume: 0.8,
    });

    // DEBUG TEST FOR playAudio() call:
    this.logger.info(`Playing confirmation sound for photo at stage ${stage}.`);
    // // 1. Take photo
    // const photo = await session.camera.requestPhoto();
    // this.logger.info(
    //   `Photo captured for stage ${stage}. ts=${photo.timestamp}`
    // );

    // this.cachePhoto(photo, PokerCoachMentraApp.DEMO_USER_ID);

    // 2. Detect cards
    const detected = await this.detectCards(photo);
    this.logger.info(`Detected ${stage} cards: ${JSON.stringify(detected)}`);

    let expectedCount: number;
    if (stage === "hole") {
      expectedCount = 2;
    } else if (stage === "flop") {
      expectedCount = 3;
    } else if (stage === "turn") {
      expectedCount = 4;
    } else {
      expectedCount = 5;
    }

    // const ops = {
    //   voice_id: "WdZjiN0nNcik2LBjOHiv",
    //   model_id: "eleven_flash_v2_5",
    //   voice_settings: {
    //     stability: 0.4,
    //     similarity_boost: 0.85,
    //     style: 0.6,
    //     speed: 0.95,
    //   },
    // };

    if (detected.length !== expectedCount) {
      this.logger.warn(
        `Expected ${expectedCount} card(s) at ${stage}, got ${detected.length}`
      );
      await session.audio.speak(
        `I couldn't detect the expected number of cards. Please try taking the photo again, making sure all cards are clearly visible.`,
        ops
      );

      // Reset board for this stage so it doesn't accumulate on retries
      if (stage === "hole") {
        this.globalState.hole = [];
      } else {
        this.globalState.board = [];
      }

      // Do not advance stage or reset state; just return to let user try
      return;
    }

    // 3. Update state
    if (stage === "hole") this.globalState.hole = detected;
    else this.globalState.board = detected;

    // 4. Get analysis
    const analysis = await this.fetchHandAnalysis(this.globalState.hole, this.globalState.board);
    await session.audio.speak(
      `Your win probability is ${analysis.win_probability} percent.`,
      ops
    );
    await session.audio.speak(analysis.tip, ops);

    // 5. Advance stage
    const nextStageMap: Record<Stage, Stage> = {
      "hole": "await_hole_photo",
      "await_hole_photo": "flop",
      "flop": "await_flop_photo",
      "await_flop_photo": "turn",
      "turn": "await_turn_photo",
      "await_turn_photo": "river",
      "river": "await_river_photo",
      "await_river_photo": "hole"
    };
    this.logger.info("" + `Advancing stage from ${this.globalState.stage} to ${nextStageMap[this.globalState.stage]}`);
    this.globalState.stage = nextStageMap[this.globalState.stage];

    // If we completed river, reset state entirely and clear conversation history
    if (stage === "river") {
      this.logger.info(
        `Hand complete. Resetting global state.`
      );
      this.resetGlobalState();

      // Clear the conversation history to prepare for a new round
      this.conversationHistory = [
        {
          role: "system",
          content:
            "You are a intelligent poker assistant for new players. " +
            "The user will give you a Texas Hold'em hand and optionally the flop, turn, or river, depending on the phase of the game. " +
            "You will analyze the hand and return a JSON object with the win probability and a one-sentence tip. " +
            "The win probability should be a number between 0 and 100, inclusive. " +
            "The tip should be easy to understand for a beginner poker player. " +
            "Format the tip for a beginner, and seek to teach in addition to provide advice " +
            "Do not simply repeat the Win Probability." +
            "There are always 4 players at the table. " +
            "Return only a raw JSON object. Do not include any markdown, code block, or explanation." +
            "Do not use emojis or special characters.",
        },
      ];
    }
  }

  /* ────────────────────────── External API Calls ─────────────────────────── */
  private async detectCards(photo: PhotoData): Promise<string[]> {
    const photoUrl = `${this.getServerUrl()}/api/photo/${photo.requestId}`;
    const roboflowURL =
      `https://pokerclass.roboflow.cloud/playing-cards-ow27d/4?` +
      new URLSearchParams({
        api_key: ROBOFLOW_API_KEY,
        image: photoUrl,
      }).toString();

    this.logger.info(`Roboflow URL → ${roboflowURL}`);

    const rfRes = await fetch(roboflowURL);
    if (!rfRes.ok) {
      const errText = await rfRes.text().catch(() => "");
      throw new Error(
        `Roboflow API error: ${rfRes.status} ${rfRes.statusText} – ${errText}`
      );
    }

    const rfJson = await rfRes.json();
    this.logger.debug(`Roboflow response: ${JSON.stringify(rfJson)}`);

    const raw = Array.isArray(rfJson.predictions) ? rfJson.predictions : [];
    // Remove duplicates while preserving order
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const p of raw) {
      if (typeof p.class === "string" && !seen.has(p.class)) {
        seen.add(p.class);
        unique.push(p.class);
      }
    }
    return unique;
  }

  private conversationHistory: Message[] = [
    {
      role: "system",
      content:
        "You are a intelligent poker assistant for new players. " +
        "The user will give you a Texas Hold'em hand and optionally the flop, turn, or river, depending on the phase of the game. " +
        "You will analyze the hand and return a JSON object with the win probability and a one-sentence tip. " +
        "The win probability should be a number between 0 and 100, inclusive. " +
        "The tip should be easy to understand for a beginner poker player. " +
        "Format the tip for a beginner, and seek to teach in addition to provide advice " +
        "Do not simply repeat the Win Probability." +
        "There are always 4 players at the table. " +
        "Return only a raw JSON object. Do not include any markdown, code block, or explanation." +
        "Do not use emojis or special characters.",
    },
  ];

  private async fetchHandAnalysis(
    hole: string[],
    board: string[]
  ): Promise<{ win_probability: number; tip: string }> {
    const stages = ["pre-flop", "flop", "turn", "river"] as const;
    const stage = stages[board.length];

    const userMessage: Message = {
      role: "user",
      content:
        `Stage: ${stage}. ` +
        `My hand is ${hole.join(" and ")}.` +
        (board.length ? ` Community cards: ${board.join(", ")}.` : "") +
        " Return a JSON object in the format: " +
        '{win_probability: number (0–100), tip: "A one-sentence tip to be read aloud to the player."}',
    };

    // Add user query to history
    this.conversationHistory.push(userMessage);

    const openaiPayload = {
      model: "o3-mini",
      messages: this.conversationHistory,
    };

    this.logger.info(
      `[OpenAI] Payload: ${JSON.stringify(openaiPayload, null, 2)}`
    );

    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(openaiPayload),
      }
    );

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      this.logger.error(
        `[OpenAI] Error ${openaiRes.status} ${openaiRes.statusText}`
      );
      this.logger.error(`[OpenAI] Body: ${errText}`);
      throw new Error(
        `OpenAI API error: ${openaiRes.status} ${openaiRes.statusText} – ${errText}`
      );
    }

    const json = await openaiRes.json();
    const content = json.choices?.[0]?.message?.content?.trim();

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      this.logger.error(`[OpenAI] Invalid JSON: ${content}`);
      throw new Error(`Failed to parse OpenAI response as JSON: ${content}`);
    }

    // Save assistant response to history
    this.conversationHistory.push({
      role: "assistant",
      content: content ?? "",
    });

    return {
      win_probability: Math.max(0, Math.min(100, parsed.win_probability)),
      tip: parsed.tip,
    };
  }

  /* ────────────────────────── Photo Caching & Web ────────────────────────── */
  private cachePhoto(photo: PhotoData, userId: string) {
    userId = PokerCoachMentraApp.DEMO_USER_ID;

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
    const DEMO_USER_ID = PokerCoachMentraApp.DEMO_USER_ID;

    // Latest photo meta
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
    const protocol = process.env.PUBLIC_URL?.startsWith("https")
      ? "https"
      : "http";
    return process.env.PUBLIC_URL || `${protocol}://localhost:${PORT}`;
  }
}

/* ──────────────────────────────── Boot ──────────────────────────────────── */
const app = new PokerCoachMentraApp();
app.start().catch((err) => console.error(err));
