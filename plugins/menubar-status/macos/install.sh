#!/bin/zsh
# Installs the bb menu bar panel for the current macOS user:
# the local helper (a LaunchAgent on 127.0.0.1) and the SwiftBar script.
# Run from this directory: zsh install.sh
set -eu
HERE="${0:A:h}"
DIR="$HOME/Library/Application Support/bb-menubar"
AGENT="$HOME/Library/LaunchAgents/dev.bb.menubar.plist"
PY="$(command -v python3 || echo /usr/bin/python3)"
mkdir -p "$DIR/swiftbar" "$HOME/Library/LaunchAgents"
cp "$HERE/server.py" "$HERE/panel.html" "$DIR/"
cp "$HERE/bb-agents.5s.py" "$DIR/swiftbar/"
chmod +x "$DIR/swiftbar/bb-agents.5s.py"
if [ ! -s "$DIR/token" ]; then
  (umask 077; openssl rand -hex 24 > "$DIR/token")
fi
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.bb.menubar</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DIR/server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DIR/server.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/dev.bb.menubar" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
defaults write com.ameba.SwiftBar PluginDirectory -string "$DIR/swiftbar"
echo "installed: helper on 127.0.0.1:47615, SwiftBar script in $DIR/swiftbar"
