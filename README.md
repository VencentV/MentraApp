# 🔍 VisionTalk: AI Visual Reasoning Assistant for Mentra Live Glasses

**VisionTalk** transforms your Mentra Live smart glasses into an intelligent visual assistant. Simply look at anything, press a button, and get instant AI-powered explanations spoken directly to your ears.

<div align="center">
  <img src="https://via.placeholder.com/500x300/667eea/ffffff?text=VisionTalk+Demo" alt="VisionTalk in action" width="500"/>
  <p><em>AI glasses that understand what you're looking at</em></p>
</div>

## 🎯 What VisionTalk Does

**The simplest possible interaction:** See → Snap → Answer → Speak

- **Look** at homework, signs, objects, food, plants, devices, etc.
- **Press** the Mentra glasses button to capture what you're seeing
- **Listen** as VisionTalk analyzes and explains it in natural speech
- **Learn** from AI-powered insights delivered hands-free

## 🌟 Example Interactions

| **Scenario** | **What You Do** | **What VisionTalk Says** |
|--------------|-----------------|--------------------------|
| 📚 Homework question | Look at math problem, press button | *"This is asking you to solve for X using the quadratic formula. Here's how to approach it step by step..."* |
| 📖 Book passage | Look at text, press button | *"This quote is from Shakespeare's Hamlet, where he's contemplating the nature of existence..."* |
| 🌱 Houseplant | Look at plant, press button | *"This appears to be a monstera deliciosa. The yellowing leaves suggest it may be overwatered..."* |
| 🔧 Device/Gadget | Look at unfamiliar object, press button | *"This is a digital multimeter used to measure electrical voltage, current, and resistance..."* |
| 🥘 Fridge contents | Look inside fridge, press button | *"I can see eggs, spinach, cheese, and tomatoes. You could make a delicious spinach and cheese omelet..."* |

## 🏗️ Technical Architecture

### **Core Loop**
```
👀 Visual Input → 📸 Photo Capture → 🧠 GPT-4V Analysis → 🗣️ Voice Output
```

### **Key Components**
- **MentraOS SDK** - Smart glasses integration, camera control, audio output
- **GPT-4V (OpenAI)** - Advanced visual reasoning and natural language explanation
- **ElevenLabs** - Natural voice synthesis for audio responses
- **Express.js** - Web server for photo handling and debugging interface
- **Node.js + TypeScript** - Fast development with type safety and hot reload

### **Smart Features**
- **Context-aware analysis** - Understands text, objects, scenes, and complex situations
- **Educational explanations** - Provides learning-focused responses, not just descriptions
- **Hands-free operation** - No typing, no phone interaction required
- **Real-time processing** - Sub-5-second response times from capture to speech
- **Visual debugging** - Web interface shows captured photos for development

## 🚀 Quick Start

### **Prerequisites**
- Mentra Live smart glasses
- Node.js (v18+ recommended) installed
- API keys for OpenAI, ElevenLabs, and MentraOS

### **Setup**
```bash
# Clone and navigate to VisionTalk
cd VisionTalk

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your API keys
# PACKAGE_NAME=com.visiontalk.assistant
# MENTRAOS_API_KEY=your_mentraos_key
# OPENAI_API_KEY=your_openai_key  
# ELEVENLABS_API_KEY=your_elevenlabs_key

# Start development server
npm run dev

# In another terminal, expose to internet for Mentra glasses
npx ngrok http 3000
# Update .env with your ngrok URL

# View debug interface
start http://localhost:3000/webview
```

### **Usage**
1. **Put on your Mentra glasses**
2. **Look at anything interesting** - homework, objects, text, scenes
3. **Press the glasses button** - VisionTalk captures the image
4. **Listen to the explanation** - AI analyzes and speaks the answer

## 🎛️ Configuration

### **Voice Settings**
Customize the voice experience in `src/index.ts`:
```typescript
const voiceConfig = {
  voice_id: "WdZjiN0nNcik2LBjOHiv", // David Attenborough
  model_id: "eleven_flash_v2_5",
  voice_settings: {
    stability: 0.5,      // Voice consistency
    similarity_boost: 0.8, // Voice accuracy
    style: 0.4,          // Speaking style variation
    speed: 0.9,          // Speaking speed
  },
};
```

### **AI Analysis Prompt**
Modify the system prompt to customize VisionTalk's personality and focus:
```typescript
// In analyzeImageWithGPT4V() method
"You are VisionTalk, an AI assistant that helps people understand what they're looking at..."
```

## 🔧 Development

### **Project Structure**
```
VisionTalk/
├── src/
│   └── index.ts          # Main application logic
├── views/
│   └── photo-viewer.ejs  # Web debugging interface
├── assets/              # Static files (audio, images)
├── package.json         # Dependencies and scripts
└── .env.example         # Environment template
```

### **Key Files**
- **`src/index.ts`** - Core VisionTalk application with MentraOS integration
- **`views/photo-viewer.ejs`** - Real-time photo viewer for debugging
- **`.env`** - API keys and configuration (create from .env.example)

### **Debugging**
- Visit `http://localhost:3000/webview` to see captured photos in real-time
- Check console logs for API responses and error messages
- Use long press on glasses to reset session state

## 🌍 Use Cases

### **Education**
- **Students** - Get homework help, concept explanations, reading comprehension
- **Learners** - Understand complex diagrams, foreign text, scientific concepts

### **Daily Life**
- **Cooking** - Identify ingredients, get recipe suggestions, understand nutrition labels
- **Shopping** - Read product information, compare options, understand instructions
- **Maintenance** - Identify tools, understand repair procedures, troubleshoot devices

### **Accessibility**
- **Visual assistance** - Describe surroundings, read signs, identify objects
- **Learning support** - Audio explanations for visual learners, concept clarification

## 🎯 What Makes VisionTalk Special

### **Hands-Free Intelligence**
- No need to pull out your phone or type questions
- Natural interaction through looking and button pressing
- Audio responses keep your hands free for other tasks

### **Context-Aware Analysis** 
- Goes beyond simple object detection to provide reasoning and explanation
- Understands text, scenes, relationships, and complex visual information
- Provides educational value, not just identification

### **Real-Time Responsiveness**
- Fast processing pipeline optimized for immediate feedback
- Sub-5-second response times from capture to speech
- Efficient API usage and caching for smooth operation

## 🚧 Future Enhancements

- **Multi-language support** - Analyze and respond in different languages
- **Conversation memory** - Remember previous questions for contextual follow-ups  
- **Specialized modes** - Subject-specific analysis (math, science, cooking, etc.)
- **Voice commands** - Skip button press for even more natural interaction
- **Offline capabilities** - Local processing for privacy-sensitive scenarios

## Run
- npm run dev
- ngrok http http://127.0.0.1:3000
- https://dashboard.ngrok.com/get-started/setup/windows


---

**Built for hackathons, optimized for learning, designed for the future.** 🚀

*VisionTalk transforms any visual question into an instant audio answer.*