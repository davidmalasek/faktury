#!/bin/bash
# Vytvoří spouštěč Faktury.app ve složce Aplikace (nebo ve složce z 1. argumentu).
# Spouštěč jen zavolá spustit.sh z této složky. Když složku projektu přesuneš, spusť instalaci znovu.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(pwd)
DEST=${1:-/Applications}
APP="$DEST/Faktury.app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# cesta jako řetězec v AppleScriptu
path=${REPO//\\/\\\\}
path=${path//\"/\\\"}

cat > "$TMP/faktury.applescript" <<EOF
on run
	set appFolder to "$path"
	set launcher to appFolder & "/spustit.sh"
	try
		do shell script "test -x " & quoted form of launcher
	on error
		display alert "Faktury nejdou spustit" message "Složka aplikace není na svém místě:" & return & appFolder & return & return & "Pokud se přesunula, spusť v ní znovu instalovat.sh."
		return
	end try
	do shell script quoted form of launcher
end run
EOF

osacompile -o "$TMP/Faktury.app" "$TMP/faktury.applescript"
cp macos/Faktury.icns "$TMP/Faktury.app/Contents/Resources/applet.icns"
rm -f "$TMP/Faktury.app/Contents/Resources/Assets.car"
PLIST="$TMP/Faktury.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.faktury" "$PLIST" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.faktury" "$PLIST"
codesign --force --deep --sign - "$TMP/Faktury.app"

rm -rf "$APP"
ditto "$TMP/Faktury.app" "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Hotovo: $APP"
