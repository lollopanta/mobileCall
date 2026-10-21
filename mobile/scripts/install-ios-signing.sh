#!/usr/bin/env bash
set -euo pipefail
umask 077

printf '%s' "$IOS_CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/signing.p12"
printf '%s' "$IOS_PROFILE_BASE64" | base64 --decode > "$RUNNER_TEMP/profile.mobileprovision"
mkdir -p "$RUNNER_TEMP/asc-keys"
printf '%s' "$ASC_PRIVATE_KEY" > "$RUNNER_TEMP/asc-keys/AuthKey_${ASC_KEY_ID}.p8"
security cms -D -i "$RUNNER_TEMP/profile.mobileprovision" > "$RUNNER_TEMP/profile.plist"

python3 scripts/validate-ios-profile.py

keychain_path="$RUNNER_TEMP/mobilecall-signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"
echo "::add-mask::$keychain_password"
security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$RUNNER_TEMP/signing.p12" -P "$IOS_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain_path"
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$keychain_password" "$keychain_path" >/dev/null
security list-keychains -d user -s "$keychain_path" "$HOME/Library/Keychains/login.keychain-db"
security find-identity -v -p codesigning "$keychain_path"

# Xcode 16+ uses the Developer/Xcode directory; install in both locations.
for directory in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
  mkdir -p "$directory"
  cp "$RUNNER_TEMP/profile.mobileprovision" "$directory/mobilecall-ci.mobileprovision"
done

# CocoaPods may use a different Ruby than the runner's default executable.
if ! ruby -e "require 'xcodeproj'" 2>/dev/null; then
  gem install --user-install xcodeproj --no-document
fi
ruby <<'RUBY'
require 'xcodeproj'
require 'json'
metadata = JSON.parse(File.read(File.join(ENV.fetch('RUNNER_TEMP'), 'signing.json')))
project = Xcodeproj::Project.open('ios/MobileCall.xcodeproj')
project.targets.select { |target| target.name == 'MobileCall' }.each do |target|
  target.build_configurations.each do |configuration|
    configuration.build_settings['CODE_SIGN_STYLE'] = 'Manual'
    configuration.build_settings['DEVELOPMENT_TEAM'] = metadata.fetch('team')
    configuration.build_settings['CODE_SIGN_IDENTITY'] = 'Apple Distribution'
    configuration.build_settings['PROVISIONING_PROFILE_SPECIFIER'] = metadata.fetch('uuid')
  end
end
project.save
RUBY
