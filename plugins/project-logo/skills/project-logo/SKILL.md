---
name: project-logo
description: Inspect or install an authentic shared project logo, selected using the project name and the thread's first user message.
---

# Project Logo

The plugin automatically supplies first-use instructions and native tools to
agents in standard projects. The agent uses the project name AND its first user
message to identify the subject. This uses the thread's existing agent and tools;
it does not start another thread or call a separate AI subscription.

Use `project_logo_status` to resolve the real project source host/root and check
for an icon. Existing `.bb/icon.png`, `.bb/icon.svg`, `favicon.png`,
`favicon.svg`, `favicon.ico` take priority. Project images are shared by all
threads. Machine Tabs displays them grey.

If absent, prefer artwork already in the project, then an authentic emblem from
the brand's official website. Use the compact mark without wordmark when
available. Preserve SVG as vector; PNG is also supported, maximum 256 KiB.
Never invent a brand or approximate its mark. If context is ambiguous, skip
without interrupting the user's task. A later new thread can try again.

Download to a temporary file inside the source checkout on its actual host.
Call `project_logo_install` with `filePath` relative to that root and `sourceUrl`
containing the source page URL or `project asset`. Only passive, self-contained
SVG elements are accepted; scripts, stylesheets and external references are
rejected. Use another original asset when validation rejects one. Remove your
temporary file afterwards. Do not commit/push automatically.

Manual CLI:

```sh
bb project-logo status <project-id>
bb project-logo install <project-id> <relative-image-path> <source-page-url>
```

These commands resolve the project's source host, independently of the CLI's
current working directory. They never replace an existing icon. Installation
refreshes Machine Tabs immediately; if unavailable, its regular refresh picks
the image up later. `bb machine-tabs icons` forces that refresh.

The automatic step runs when BB constructs the next provider session. A running
session may need to restart before receiving the tools/instructions. Successful
status checks mark the thread checked in this plugin's thread metadata, so
follow-up sessions do not repeat the lookup. There is no background daemon
performing independent AI requests: the active thread's agent performs the lookup
alongside its normal work. Agents may skip it under explicit user constraints or
when their search/file tools are unavailable.
