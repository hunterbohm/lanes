#!/usr/bin/env bash
# Builds Lanes.app into ~/Applications (macOS 13+, Xcode command line tools).
#   ./build.sh                    build only (signed ad hoc, so it never checks for updates; downloads of a signed
#                                 release are on the GitHub releases page)
#   ./build.sh --agents-only      skip the build and set up the login item / tunnel for the Lanes.app already in
#                                 ~/Applications (a downloaded release). Takes the same --install and --tunnel.
#   ./build.sh --install          also start Lanes at login (a LaunchAgent) and start it now
#   ./build.sh --install --tunnel HOST
#                                 also keep an SSH tunnel to HOST, where `lanes hub` runs, so the app's default address
#                                 http://127.0.0.1:8792/ reaches it. HOST is anything `ssh HOST` accepts.
set -euo pipefail
cd "$(dirname "$0")"

install=0 tunnel="" build=1
while (($#)); do
  case $1 in
    --install) install=1 ;;
    --agents-only) install=1 build=0 ;;
    --tunnel) tunnel=${2:?--tunnel needs a host}; shift
              [[ $tunnel =~ ^[A-Za-z0-9._@:-]+$ && $tunnel != -* ]] || { echo "--tunnel: give a host name, user@host or ~/.ssh/config name" >&2; exit 2; } ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

app="$HOME/Applications/Lanes.app"
agents="$HOME/Library/LaunchAgents"
id=io.github.hunterbohm.lanes

if ((build)); then
  ./assemble.sh "$app"
  codesign --force --sign - "$app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
  echo "built $app"
else
  [[ -d $app ]] || { echo "No $app. Move the downloaded Lanes.app there first." >&2; exit 1; }
fi

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
