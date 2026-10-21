# MobileCall (Universal WebRTC Voice & Video)

A modern communication platform featuring a **Python/FastAPI** signaling server and a cross-platform **React Native (Expo)** mobile/web application. Designed for families to stay connected with high-quality voice and video calls.

## 🚀 Key Features
- **Universal WebRTC**: P2P voice and video calling that works in browsers (Chrome/Safari) and natively on iOS/Android.
- **Family Management**: Group users into private families. Only family members can see each other online or initiate calls.
- **Role-Based Access**: Specialized roles (e.g., Grandparent, Caregiver) with customized UI/UX.
- **Secure Authentication**: JWT-based login and registration system with profile customization.
- **Invitation System**: Securely invite new members to your family via a pending invitation workflow.
- **Modern UI**: Dark-mode, glassmorphism-inspired design with smooth animations.

## 🛠️ Tech Stack
- **Server**: Python 3.13, FastAPI, Uvicorn, `python-socketio`, JWT, Bcrypt.
- **Mobile/Web**: Expo SDK 54, TypeScript, `react-native-webrtc`, `socket.io-client`, `axios`.
- **Database**: SQLite (local persistence for users and family data).

---

## 📦 Prerequisites
- **Python 3.13+** (Server)
- **Node.js 22+** (Mobile/Web)
- **Modern Browser**: For the web version.
- **Development Client**: Required for Android/iOS native WebRTC support (standard Expo Go is not compatible with WebRTC).

---

## 🛠️ Setup Instructions

### 1. Signaling Server (Python + venv)
Navigate to the `server` directory and install dependencies:
```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python setupDB.py  # Initialize database
python api/app.py
```
> [!NOTE]
> The server runs on port `3000` by default. Ensure your firewall allows incoming traffic on this port for LAN testing.
> Edit `server/.env` before first run. `SECRET_KEY` must be a random secret of at least 32 bytes (generate one with `python -c "import secrets; print(secrets.token_urlsafe(48))"`). The server refuses missing or example secrets. Set `DEFAULT_GRANDPARENT_PASSWORD` before database initialization if you want to use the initial `grandparent` account; otherwise its password is random and cannot be recovered. Existing account passwords are never changed by initialization.

### 2. Mobile & Web Application (`pnpm`)
Navigate to the `mobile` directory:
```bash
cd mobile
corepack enable
pnpm install --frozen-lockfile
```

#### Run on Web
```bash
pnpm exec expo start --web
```

#### Run on Android/iOS (Native)
You must build a development client or use a pre-built one that includes the native WebRTC modules.
```bash
pnpm exec expo prebuild
pnpm exec expo run:android # or ios
```

---

## 🧬 Project Structure
- **/server**: FastAPI application, SQLite database utility, and signaling logic.
- **/mobile**: Expo project with unified codebase for Web, Android, and iOS.

## 🧪 Testing Locally
1. Start the server on your primary PC.
2. Note your local IP address (e.g., `192.168.x.x`).
3. Connect multiple devices to the same Wi-Fi.
4. Log in/Register on each device and initiate calls via the "Online Family Members" list.

---

## 🔒 Security and Privacy
- **Family Isolation**: Users cannot "discover" or call anyone outside of their authorized family group.
- **Token Security**: All API requests and signaling registrations require a valid JWT bearer token.
- **Local SQLite**: User data is stored locally in `server/userDatabase.db` by default.

## Automated checks

```bash
server/.venv/bin/python -m pip install -r server/requirements-test.txt
server/.venv/bin/python -m unittest discover -s server/tests -v
cd mobile && pnpm exec tsc --noEmit
```

Incoming video auto-answer is disabled by default and can be enabled by the recipient in Profile. It applies to family caregiver calls after an audible warning; the caller cannot override the recipient's setting. Existing outgoing-call preferences are not reused as consent.

Dependency versions are recorded in `mobile/pnpm-lock.yaml` and `server/requirements-lock.txt`. Mobile uses pnpm 12; security overrides live in `mobile/pnpm-workspace.yaml`. Server installation applies the runtime lock through `requirements.txt`; use Python 3.13. After native dependency changes, rebuild the development client before testing on a device.

To repeat the dependency checks:

```bash
cd mobile
pnpm audit
# Return to the repository root, with pip-audit installed separately:
cd ..
pip-audit --no-deps --disable-pip -r server/requirements-lock.txt
```

`pnpm audit` still reports three upstream package versions. Their used entrypoints now have versioned local security backports; run `pnpm run test:security` and see `AUDIT.md` and `mobile/patches/README.md`. The raw findings are not suppressed.

To run the dependency regression tests and the two-browser calling smoke test:

```bash
cd mobile
pnpm install --frozen-lockfile
pnpm run test:security
pnpm exec playwright install --with-deps chromium --only-shell
pnpm exec expo export --platform web
pnpm run test:browser
```

The browser test starts an isolated Python server with a temporary database. It
registers two users, creates/joins a family, checks incoming-call consent, exchanges
actual audio/video RTP using simulated camera/microphone devices, verifies ICE
routing, hangs up, reloads a session, declines a call, and logs out. It never uses
the project database. Override `PYTHON` if the server virtualenv is elsewhere.
Native device and physical fall-sensor checks remain separate from browser tests.

Pairing regression coverage also uses a third browser as the grandparent display:
it verifies that video starts after controller acceptance, the display captures no
camera or microphone, and disconnecting the display leaves the main call active.
The display rejoins subsequent calls after reconnecting; automatic display reattachment
to an ongoing call is not implemented.

## Android APK with GitHub Actions (no EAS)

Open [Build Android APK](https://github.com/lollopanta/mobileCall/actions/workflows/build-apk.yml)
and select **Run workflow**, or push changes under `mobile/` to `master`.
Pull requests affecting the app also build an APK. Everything runs on GitHub's
Ubuntu runners with Node 24, JDK 17, Expo prebuild and Gradle `assembleRelease`;
no Expo login, EAS account, or repository secrets are required.

After a successful run, download **MobileCall-APK** from **Artifacts** and extract
`MobileCall-<commit>.apk`. The archive also includes `SHA256SUMS.txt`.
Artifacts expire after 14 days; rerun the workflow to generate them again.
The APK bundles JavaScript and works without Metro. It uses the generated
**development signing key**, suitable for direct installation; configure your own
production signing before publishing to a store. The signaling server must still
be running and reachable from the phone using the app's connection settings.

## iOS / TestFlight with GitHub Actions (no EAS)

[Build iOS and TestFlight](https://github.com/lollopanta/mobileCall/actions/workflows/build-ios.yml)
builds with Xcode on GitHub-hosted macOS runners. Select `unsigned` for an iPhone IPA to sign/install with AltStore Classic,
`simulator` to validate without signing, or `testflight` to sign and upload to App Store Connect.
The TestFlight mode needs an Apple Developer membership and six repository secrets;
see [the setup guide](mobile/TESTFLIGHT.md). No Expo account or EAS is used.
