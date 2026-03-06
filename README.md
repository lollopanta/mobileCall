# MobileCall (Universal WebRTC Voice & Video)

A React Native (Expo) application for voice and video calls over a local network (LAN). Supports both **Web browsers** and **Android/iOS** devices using WebRTC and a Socket.io signaling server.

## Features
- **Universal Support**: Runs on Web (Chrome/Safari) and Native (Android/iOS).
- **LAN Presence**: Automatically detect other users on your Wi-Fi.
- **Voice & Video**: High-quality P2P communication.
- **Call Controls**: Mute, Camera toggle, and Call management.

## Technologies Used
- **Mobile**: Expo SDK 54, TypeScript, `react-native-webrtc`, `socket.io-client`.
- **Server**: Node.js, Express, `socket.io`.

---

## Prerequisites
- Node.js (v18+)
- **For Web**: Just a modern browser (Chrome, Safari, Firefox).
- **For Android/iOS**: A physical device and a **Development Build** (WebRTC does not work in standard Expo Go).

---

## Setup Instructions

### 1. Signaling Server
1. Navigate to the server directory:
   ```bash
   cd server
   npm install
   npm start
   ```
2. Note your computer's LAN IP (e.g., `192.168.1.15`).

### 2. Mobile App (Web Mode - Easiest)
1. Navigate to the mobile directory:
   ```bash
   cd mobile
   npm install
   npx expo start --web
   ```
2. Open the URL in two different browser tabs to test immediately.

### 3. Mobile App (Android/iOS Native)
1. Install dependencies in the `mobile` folder.
2. Build the development client:
   - Android: `npx expo run:android`
   - iOS: `npx expo run:ios` (Requires Mac)
3. Once the app is installed on your phone, run `npx expo start --dev-client`.

---

## How to Test on LAN
1. **Server IP**: Find your PC's IP using `ipconfig` (Windows).
2. **Start Server**: Ensure the signaling server is running.
3. **Connect**: 
   - Open the app on two devices (e.g., one PC browser and one Android phone).
   - Enter a username and the **Server IP**.
4. **Call**: Tap **Voice** or **Video** to start the call.

---

## Troubleshooting Connection
- **Disconnect Loops**: Ensure both client and server allow `polling` and `websocket` transports.
- **Browser Errors**: If WebSockets fail in the browser, ensure the server IP is correct and your Firewall allows traffic on port `3000`.
- **Native Crash**: If the app crashes on Android, ensure you are using a **Development Build** and not standard Expo Go.
