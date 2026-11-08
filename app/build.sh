#!/usr/bin/env bash
# Builds Lanes.app into ~/Applications (macOS 13+, Xcode command line tools).
#   ./build.sh                    build only
#   ./build.sh --install          also start Lanes at login (a LaunchAgent) and start it now
#   ./build.sh --install --tunnel HOST
#                                 also keep an SSH tunnel to HOST, where `lanes hub` runs, so the app's default address
#                                 http://127.0.0.1:8792/ reaches it. HOST is anything `ssh HOST` accepts.
set -euo pipefail
cd "$(dirname "$0")"

install=0 tunnel=""
while (($#)); do
  case $1 in
    --install) install=1 ;;
    --tunnel) tunnel=${2:?--tunnel needs a host}; shift
              [[ $tunnel =~ ^[A-Za-z0-9._@:-]+$ && $tunnel != -* ]] || { echo "--tunnel: give a host name, user@host or ~/.ssh/config name" >&2; exit 2; } ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

app="$HOME/Applications/Lanes.app"
agents="$HOME/Library/LaunchAgents"
id=io.github.hunterbohm.lanes

rm -rf build && mkdir -p build/AppIcon.iconset
swiftc -O -o build/Lanes Sources/main.swift -framework Cocoa -framework WebKit
swift make-icon.swift build/icon-master.png >/dev/null
for size in 16 32 128 256 512; do
  sips -z $size $size build/icon-master.png --out "build/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) build/icon-master.png --out "build/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp build/Lanes "$app/Contents/MacOS/"
cp build/AppIcon.icns "$app/Contents/Resources/"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$id</string>
  <key>CFBundleName</key><string>Lanes</string>
  <key>CFBundleDisplayName</key><string>Lanes</string>
  <key>CFBundleExecutable</key><string>Lanes</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>$id</string>
    <key>CFBundleURLSchemes</key><array><string>lanes</string></array>
  </dict></array>
  <!-- The hub speaks plain HTTP: on 127.0.0.1 through a tunnel, or at an address you set on your own network. -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>
EOF
codesign --force --sign - "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "built $app"

((install)) || exit 0

load() {   # load (or reload) one LaunchAgent
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  # bootout returns before the old copy is gone, and bootstrap fails while it lingers.
  for _ in $(seq 20); do launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap "gui/$(id -u)" "$agents/$1.plist"
  echo "loaded $1"
}

mkdir -p "$agents"
if [[ -n $tunnel ]]; then
  cat > "$agents/$id.tunnel.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$id.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/ssh</string><string>-N</string><string>-T</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>ClearAllForwardings=no</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ConnectTimeout=10</string>
    <string>-o</string><string>ServerAliveInterval=15</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-L</string><string>127.0.0.1:8792:127.0.0.1:8792</string>
    <string>--</string><string>$tunnel</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/lanes-tunnel.log</string>
</dict></plist>
EOF
  load "$id.tunnel"
fi

cat > "$agents/$id.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$id</string>
  <key>ProgramArguments</key><array><string>$app/Contents/MacOS/Lanes</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/lanes.log</string>
</dict></plist>
EOF
load "$id"
