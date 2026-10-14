#!/bin/bash
# Sestaví aplikaci Faktury.app s vlastním oknem do složky Aplikace (nebo do složky z 1. argumentu).
# Aplikace spouští server z této složky. Když složku projektu přesuneš, spusť instalaci znovu.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(pwd)
DEST=${1:-/Applications}
APP="$DEST/Faktury.app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Chybí vývojářské nástroje macOS (Command Line Tools). Nainstaluj je příkazem" >&2
  echo "  xcode-select --install" >&2
  echo "a pak spusť ./instalovat.sh znovu." >&2
  exit 1
fi

echo "Sestavuji Faktury.app…"
CONTENTS="$TMP/Faktury.app/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
xcrun swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos12.0" \
  -o "$CONTENTS/MacOS/Faktury" macos/Faktury.swift
cp macos/Faktury.icns "$CONTENTS/Resources/Faktury.icns"
cat > "$CONTENTS/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>cs</string>
	<key>CFBundleLocalizations</key>
	<array>
		<string>cs</string>
	</array>
	<key>CFBundleExecutable</key>
	<string>Faktury</string>
	<key>CFBundleIconFile</key>
	<string>Faktury</string>
	<key>CFBundleIdentifier</key>
	<string>local.faktury</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Faktury</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.finance</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
EOF
# složka projektu, ze které aplikace spouští server
plutil -insert FakturyFolder -string "$REPO" "$CONTENTS/Info.plist"
codesign --force --sign - "$TMP/Faktury.app"

rm -rf "$APP"
ditto "$TMP/Faktury.app" "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Hotovo: $APP"
