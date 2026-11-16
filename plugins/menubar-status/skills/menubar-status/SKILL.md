---
name: menubar-status
description: Inspect or resync the agent status file that feeds the macOS menu bar widget (`bb menubar-status`).
---

# Menubar Status

The Menubar Status plugin writes a small JSON summary of the agents (who needs
the user, who is running, the last reply of each) to a file on one machine. A
SwiftBar widget on that machine reads the file and shows a count in the menu
bar and the list on click. The widget makes no network calls.

- `bb menubar-status show` — print the feed the widget would get.
- `bb menubar-status sync` — write the file now.
- Settings (`bb plugin config menubar-status set <key> <value>`): `hostId`
  (machine with the widget), `filePath` (absolute path of the file there),
  `webUrl` (public BB address for "open in browser" links), `maxItems`.

The file is rewritten on thread events and at least once a minute; the widget
marks the data stale when the file is older than three minutes (machine
asleep, server down). The widget script is `macos/bb-agents.5s.py` in the
plugin's source.

On the Mac, `macos/install.sh` also installs a local helper (LaunchAgent
`dev.bb.menubar`, 127.0.0.1:47615, token-protected) that serves
`macos/panel.html`: a left click on the menu bar title opens it as a popover,
a right click opens the plain SwiftBar menu. Check it with
`launchctl print gui/$(id -u)/dev.bb.menubar`.
