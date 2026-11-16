#!/bin/zsh
# Installs the bb menu bar item for the current macOS user:
#  - bb Status.app, a native menu bar item (panel on hover, click to pin),
#    started at login by a LaunchAgent;
#  - the local helper (127.0.0.1:47615, LaunchAgent) that serves the panel
#    from the files the menubar-status plugin keeps in this folder.
# Neither calls bb: the plugin writes the data here and picks replies up.
# Needs the Xcode Command Line Tools (swiftc) and this Mac enrolled in bb.
# Run from this directory: zsh install.sh
set -eu
HERE="${0:A:h}"
DIR="$HOME/Library/Application Support/bb-menubar"
APP="$DIR/bb Status.app"
AGENTS="$HOME/Library/LaunchAgents"
PY="$(command -v python3 || echo /usr/bin/python3)"
command -v swiftc >/dev/null || { echo "swiftc not found: run xcode-select --install" >&2; exit 1; }

mkdir -p "$DIR" "$AGENTS" "$APP/Contents/MacOS"
cp "$HERE/server.py" "$HERE/panel.html" "$DIR/"
if [ ! -s "$DIR/token" ]; then
  (umask 077; openssl rand -hex 24 > "$DIR/token")
fi

swiftc -O "$HERE/BBStatus.swift" -o "$APP/Contents/MacOS/bb-status"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.bb.status</string>
  <key>CFBundleName</key><string>bb Status</string>
  <key>CFBundleExecutable</key><string>bb-status</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

agent() {  # label, then program arguments
  local label="$1"; shift
  local args=""
  for arg in "$@"; do args="$args<string>$arg</string>"; done
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$DIR/$label.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
}
agent dev.bb.menubar "$PY" "$DIR/server.py"
agent dev.bb.status "$APP/Contents/MacOS/bb-status"
rm -f "$DIR/server-url"

# The earlier SwiftBar version: remove its script so bb is not shown twice.
if [ -f "$DIR/swiftbar/bb-agents.5s.py" ]; then
  rm -f "$DIR/swiftbar/bb-agents.5s.py"
  if [ "$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)" = "$DIR/swiftbar" ]; then
    osascript -e 'quit app "SwiftBar"' >/dev/null 2>&1 || true
  fi
fi
echo "installed: bb Status in the menu bar, helper on 127.0.0.1:47615"
