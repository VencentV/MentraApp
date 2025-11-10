import { ElevenLabsClient, play } from "@elevenlabs/elevenlabs-js";
import "dotenv/config";
const elevenlabs = new ElevenLabsClient();
const audio = await elevenlabs.textToSpeech.convert("WdZjiN0nNcik2LBjOHiv", {
  text: "The first move is what sets everything in motion.",
  modelId: "eleven_flash_v2_5",
  outputFormat: "mp3_44100_128",
});
await play(audio);
