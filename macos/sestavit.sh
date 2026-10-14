#!/bin/bash
# Sestaví Faktury.app (okno je v macos/Faktury.swift).
#   macos/sestavit.sh CIL.app SLOZKA  vývojová: spouští Faktury ze SLOZKY projektu (používá ji instalovat.sh)
#   macos/sestavit.sh CIL.app         ke stažení z GitHubu: kód nese v sobě, pro Apple Silicon i Intel
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=$1
FOLDER=${2:-}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

CONTENTS="$TMP/Faktury.app/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
if [ -n "$FOLDER" ]; then ARCHS=$(uname -m); else ARCHS="arm64 x86_64"; fi
for arch in $ARCHS; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" -o "$TMP/Faktury-$arch" macos/Faktury.swift
done
lipo -create "$TMP"/Faktury-* -output "$CONTENTS/MacOS/Faktury"
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

if [ -n "$FOLDER" ]; then
  plutil -insert FakturyFolder -string "$FOLDER" "$CONTENTS/Info.plist"
else
  mkdir "$CONTENTS/Resources/app"
  git archive HEAD | tar -x -C "$CONTENTS/Resources/app"
fi
codesign --force --sign - "$TMP/Faktury.app"

rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
ditto "$TMP/Faktury.app" "$TARGET"
