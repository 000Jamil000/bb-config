---
name: menubar-status
description: Inspect or resync the agent status feed behind the macOS menu bar item and its hover panel (`bb menubar-status`), or diagnose the panel's chat and usage.
---

# Menubar Status

The Menubar Status plugin writes a small JSON summary of the agents (who needs
the user, who is running and their current step, the last reply of each) to
`status.json` on one machine. Subagents are folded into their top-level thread.
On that Mac, `bb Status.app` shows a count per state and a usage ring in the
menu bar, and a panel on hover: usage per account, the agents, and a chat
column (hover a thread to read it and reply; click it to open it in bb).

- `bb menubar-status show` — print the feed the menu bar would get.
- `bb menubar-status sync` — write the file now.
- `bb plugin rpc call menubar-status chat --input-file <json>` with
  `{"threadId": "..."}` — the conversation the panel shows.
- `send` with `{"threadId", "text"}` — what the reply field does
  (`threads.send`, mode `auto`).
- Settings (`bb plugin config menubar-status set <key> <value>`): `hostId`
  (Mac with the menu bar item), `filePath` (absolute path of `status.json`
  there), `webUrl`, `maxItems`.

The Mac never calls bb. The plugin writes everything to the folder of
`filePath` on that machine: `status.json`, `chats/<thread>.json` (the listed
threads' conversations, rewritten when a thread changes), `usage.json` (every
two minutes), and polls `outbox/` every 1.5 s for the panel's replies and
"open in bb" requests (failures go to `errors.json`). The local helper
(`macos/server.py`, LaunchAgent `dev.bb.menubar`, 127.0.0.1:47615,
token-protected) only reads those files and queues requests; the app is
LaunchAgent `dev.bb.status`. A reply that never shows up: check the plugin log
(`bb plugin logs menubar-status`) and `errors.json`. Install or update the Mac
side with `zsh install.sh` in `macos/` (needs `swiftc`).
