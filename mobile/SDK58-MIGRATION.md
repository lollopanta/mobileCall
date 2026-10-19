# Expo SDK 58

The app uses Expo 58, React Native 0.88, React 19.3, Reanimated 4.7.1,
and Worklets 0.13. Ringtones use expo-audio instead of the removed expo-av.
Safe areas use react-native-safe-area-context; splash configuration uses the
expo-splash-screen plugin. WebRTC uses 124.0.8 with config plugin 15.0.2.
WebRTC 155 was rejected during migration because its Android artifact is
missing org.webrtc.Dav1dDecoder$Natives and fails R8. Minification stays enabled.
The redundant Babel config is removed: Expo automatically applies its preset
and the installed Worklets plugin.

## Android release on macOS

The Android directory is generated and ignored by Git. The SDK 58 template
currently generates Gradle 9.4.1. Java 27 cannot run that version; use JDK 17
for this project. This does not require uninstalling Java 27.

From the mobile directory:

```sh
brew install openjdk@17
export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
# Set ANDROID_HOME to your Android SDK installation.
# Homebrew command-line tools on this Mac:
export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
pnpm install --frozen-lockfile
pnpm exec expo prebuild --platform android
cd android
./gradlew assembleRelease
```

After updating an existing SDK 54 checkout, back up any manual native changes
before regenerating with `pnpm exec expo prebuild --clean --platform android`.
Build output: `android/app/build/outputs/apk/release/app-release.apk`.
Local release builds use the generated debug signing key; configure production
signing before distributing through a store.

## Validation

Android `assembleRelease` succeeded with JDK 17 and Gradle 9.4.1, including
R8 minification and all four Android architectures. The APK was generated at
`android/app/build/outputs/apk/release/app-release.apk`. TypeScript, dependency
alignment, all six security regression tests, and Android/iOS/web bundle
exports passed. Expo Doctor passed 19 of 20 checks. No physical-device call
test or native iOS build was performed.

- `pnpm run typecheck`
- `pnpm exec expo install --check`
- `pnpm run test:security`
- `pnpm exec expo export --platform all`
- `pnpm dlx expo-doctor`

Expo Doctor still reports WebRTC as untested on the New Architecture. The
warning is intentionally visible. Verify calls, ringtone/background playback,
and camera/microphone permissions on a real device before release.

The browser smoke test requires the server's Python dependencies and Playwright
Chromium (`pnpm exec playwright install chromium --only-shell`). Override
`PYTHON` to point to a prepared environment when server/.venv is absent.
In this migration session, registration and family flows passed; calls timed
out at getUserMedia, also reproducible in an independent blank Chromium page.

The node-forge and braces security patches remain active and their regression
tests pass. Raw pnpm audit still reports their two upstream advisories.
The obsolete sprintf-js dependency and its active patch configuration are gone.
