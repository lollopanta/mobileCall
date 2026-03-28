# MobileCall (Universal WebRTC Voice & Video)

A modern communication platform featuring a **Python/Flask** signaling server and a cross-platform **React Native (Expo)** mobile/web application. Designed for families to stay connected with high-quality voice and video calls.

## 🚀 Key Features
- **Universal WebRTC**: P2P voice and video calling that works in browsers (Chrome/Safari) and natively on iOS/Android.
- **Family Management**: Group users into private families. Only family members can see each other online or initiate calls.
- **Role-Based Access**: Specialized roles (e.g., Grandparent, Caregiver) with customized UI/UX.
- **Secure Authentication**: JWT-based login and registration system with profile customization.
- **Invitation System**: Securely invite new members to your family via a pending invitation workflow.
- **Modern UI**: Dark-mode, glassmorphism-inspired design with smooth animations.

## 🛠️ Tech Stack
- **Server**: Python 3.13, Flask, Flask-SocketIO (Threading mode for stability), JWT, Bcrypt.
- **Mobile/Web**: Expo SDK 54, TypeScript, `react-native-webrtc`, `socket.io-client`, `axios`.
- **Database**: SQLite (local persistence for users and family data).

---

## 📦 Prerequisites
- **Python 3.13+** (Server)
- **Node.js 18+** (Mobile/Web)
- **Modern Browser**: For the web version.
- **Development Client**: Required for Android/iOS native WebRTC support (standard Expo Go is not compatible with WebRTC).

---

## 🛠️ Setup Instructions

### 1. Signaling Server (Python)
Navigate to the `server` directory and install dependencies:
```bash
cd server
pip install -r requirements.txt
python setupDB.py  # Initialize database
python fastapi/app.py
```
> [!NOTE]
> The server runs on port `3000` by default. Ensure your firewall allows incoming traffic on this port for LAN testing.

### 2. Mobile & Web Application
Navigate to the `mobile` directory:
```bash
cd mobile
npm install
```

#### Run on Web
```bash
npx expo start --web
```

#### Run on Android/iOS (Native)
You must build a development client or use a pre-built one that includes the native WebRTC modules.
```bash
npx expo prebuild
npx expo run:android # or ios
```

---

## 🧬 Project Structure
- **/server**: Flask application, SQLite database utility, and signaling logic.
- **/mobile**: Expo project with unified codebase for Web, Android, and iOS.
- **/brain**: AI-generated documentation, task lists, and implementation plans.

## 🧪 Testing Locally
1. Start the server on your primary PC.
2. Note your local IP address (e.g., `192.168.x.x`).
3. Connect multiple devices to the same Wi-Fi.
4. Log in/Register on each device and initiate calls via the "Online Family Members" list.

---

## 🔒 Security and Privacy
- **Family Isolation**: Users cannot "discover" or call anyone outside of their authorized family group.
- **Token Security**: All API requests and signaling registrations require a valid JWT bearer token.
- **Local SQLite**: User data is stored locally in `mobile_call.db` by default.

