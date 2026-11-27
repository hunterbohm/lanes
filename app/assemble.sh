#!/usr/bin/env bash
# Builds an unsigned Lanes.app. Usage: assemble.sh APP_PATH [VERSION]   (macOS 13+, Xcode command line tools)
# build.sh signs the result ad hoc for a source install; release.sh signs it with the Developer ID certificate.
set -euo pipefail
cd "$(dirname "$0")"
app="${1:?usage: assemble.sh APP_PATH [VERSION]}"
version="${2:-0.1.0}"
id=io.github.hunterbohm.lanes

rm -rf build/AppIcon.iconset build/Lanes build/icon-master.png build/AppIcon.icns
mkdir -p build/AppIcon.iconset
swiftc -O -o build/Lanes Sources/main.swift Sources/Update.swift -framework Cocoa -framework WebKit
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
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$id</string>
  <key>CFBundleName</key><string>Lanes</string>
  <key>CFBundleDisplayName</key><string>Lanes</string>
  <key>CFBundleExecutable</key><string>Lanes</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>$id</string>
    <key>CFBundleURLSchemes</key><array><string>lanes</string></array>
  </dict></array>
  <!-- The hub speaks plain HTTP: on 127.0.0.1 through a tunnel, or at an address you set on your own network. -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>
PLIST
