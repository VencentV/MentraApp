# 🂡 AceSense: AR Poker Coach for Mentra Live Glasses

📍 **Mentra Live Hackathon @ YC SF** — July 12–13, 2025  
🥇 **Best Use of Roboflow**  
🥇 **Best Use of ElevenLabs**

AceSense is a real-time AR poker coach for Mentra Live smart glasses, built with the MentraOS SDK. It detects your cards, calculates win probability using GPT‑3, and speaks strategic tips aloud via ElevenLabs—keeping your hands free and your eyes on the game.

<div align="center">
  <img src="./Photo.png" alt="AceSense in action" width="400"/>
  <p style="margin-top: 0.5em;">Real-time card analysis using Mentra Live glasses.</p>
</div>

## ⚙️ Tools & Technologies

### Platform & Runtime
- **MentraOS SDK** — Provides camera control and AR UI on Mentra Live smart glasses  
- **Bun** — Lightweight backend runtime for low-latency processing  
- **ngrok** — Tunnels local backend to public URL for device integration

### ML & AI
- **Roboflow (YOLOv11 → RF-DETR)** — Initialized with a pretrained YOLOv11 model on the [Playing Cards Dataset](https://universe.roboflow.com/augmented-startups/playing-cards-ow27d)  
  - Applied **±45° shear augmentations** to account for **viewing angle distortions**, doubling dataset to 20k images.
  - Fine-tuned using **RF-DETR** (a DETR-based transformer model) for improved bounding box accuracy under angular variation
- **OpenAI GPT-3.5 (o3-mini)** — Performs reasoning to estimate win probability and generate concise strategy tips  
- **ElevenLabs** — Converts tips into natural-sounding audio, spoken aloud through the headset
  
### Design & Planning
- [Figma Board](https://www.figma.com/board/V6G4oM1Z7IEj5uv8i8kcV6/Mentra-Live-Brainstorm?node-id=0-1&t=92njWwzU1czMSzhB-1) — Ideation and UI planning


## 🚀 How It Works

1. MentraOS captures an image of the player's hand  
2. Image is sent to Roboflow for card detection (via YOLOv11 or RF-DETR)  
3. Detected card values are passed to OpenAI's o3-mini for odds estimation and tip generation  
4. ElevenLabs synthesizes the tip into David Attenborough's voice  
5. Output is delivered directly through the Mentra Live on-ear speakers in real time.


## 🛠 Local Dev

```bash
# Start backend server
bun run dev

# Expose to MentraOS device
ngrok http --url=grouse-next-especially.ngrok-free.app 3000
```

You'll need API keys for:
- Roboflow  
- OpenAI  
- ElevenLabs
- MentraOS
