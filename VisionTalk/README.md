# 🔍 VisionTalk: AI Visual Reasoning Assistant for Mentra Live Glasses

VisionTalk transforms your Mentra Live smart glasses into an intelligent visual assistant. Look → press → hear an explanation.

## Quick Start (Node.js)

Prereqs:
- Node.js v18+
- MentraOS app on your phone, paired with compatible glasses
- ngrok installed (free is fine)
- API keys: MentraOS, OpenAI, ElevenLabs

### 1) Install & configure
```powershell
npm install
cp .env.example .env
# edit .env → PACKAGE_NAME, MENTRAOS_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY,
# and PUBLIC_URL (set to your current ngrok domain)
```

### 2) Run locally
```powershell
npm run dev
```
- Local endpoints: http://localhost:3000, /health, /webview

### 3) Start ngrok (free plan)
```powershell
ngrok http http://127.0.0.1:3000
```
- Copy the forwarding https://<random>.ngrok-free.dev into `.env` as PUBLIC_URL
- Also set the same Public URL in MentraOS Developer Console (no trailing slash)

### 4) Test public endpoints (bypass ngrok warning)
```powershell
Invoke-WebRequest -UseBasicParsing -Headers @{ 'ngrok-skip-browser-warning'='true' } https://<your-domain>.ngrok-free.dev/ | Select -ExpandProperty Content
Invoke-WebRequest -UseBasicParsing -Headers @{ 'ngrok-skip-browser-warning'='true' } https://<your-domain>.ngrok-free.dev/health | Select -ExpandProperty Content
```

### 5) MentraOS Console setup
- Package name: matches `.env` (e.g., com.visiontalk.assistant)
- Public URL: your ngrok domain (https, no trailing slash)
- Permissions: Microphone + Transcripts
- Webhook: the platform will POST to `/webhook` (already implemented)
- After any code/URL change: restart the app in the MentraOS phone app

### 6) Use on glasses
- Launch VisionTalk on the phone’s MentraOS app
- You’ll hear the welcome line
- Look at something → press the button once
- You’ll hear “Stay still…”, a chime, “Analyzing…”, then the explanation
- Open http://localhost:3000/webview to see captured photos

## Endpoints
- `GET /` → service status JSON
- `GET /health` → health JSON { app, activeSessions, hasPhoto, processing, time }
- `GET /webview` → photo viewer for debugging
- `GET /api/latest-photo` and `GET /api/photo/:requestId` → latest photo APIs
- `POST /webhook` → Mentra platform events (minimal ack)

## Notes
- Free ngrok domains change when you restart the tunnel. Update `.env` PUBLIC_URL and the Console, then restart the VisionTalk app on the phone.
- If a browser shows an ngrok warning page, add header `ngrok-skip-browser-warning: true` or use the `?ngrok-skip-browser-warning=1` query param.
- Long-press the glasses button to reset the VisionTalk session.
- Blur handling: each captured photo receives a Laplacian sharpness score. If `PHOTO_SHARPNESS_THRESHOLD` (default 28) exceeds the score, a low-quality hint is injected into the GPT prompt instructing best‑effort transcription with `?` for uncertain characters (no retake request). Score is visible in the webview metadata.

## Security
- Never commit real API keys. Store them in `.env` locally.
- Rotate keys if leaked; restart the server after changes.
