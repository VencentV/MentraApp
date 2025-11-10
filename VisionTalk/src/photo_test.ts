import { AppServer, AppSession } from "@mentra/sdk";
import 'dotenv/config';

const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.visiontalk.assistant";
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY || "";
const PORT = parseInt(process.env.PORT || "3000", 10);

class PhotoTestServer extends AppServer {
  constructor() {
    super({ packageName: PACKAGE_NAME, apiKey: MENTRAOS_API_KEY, port: PORT });
  }

  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    console.log(`[PhotoTest] Session started for user: ${userId}`);
    session.events.onButtonPress(async ({ pressType }) => {
      if (pressType !== "short") return;
      console.log("[PhotoTest] Button pressed. Requesting photo...");
      try {
        const photo = await session.camera.requestPhoto({ size: "small" });
        console.log("[PhotoTest] Photo received:");
        console.log(`  requestId: ${photo.requestId}`);
        console.log(`  filename: ${photo.filename}`);
        console.log(`  mimeType: ${photo.mimeType}`);
        console.log(`  size: ${photo.size} bytes`);
        console.log(`  timestamp: ${photo.timestamp}`);
      } catch (err) {
        console.error("[PhotoTest] Photo request failed:", err);
      }
    });
  }
}

new PhotoTestServer().start().catch((err) => {
  console.error("[PhotoTest] Server error:", err);
});
