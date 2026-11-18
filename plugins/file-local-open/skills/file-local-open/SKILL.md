---
name: file-local-open
description: Open generated server files on an enrolled Mac or Windows PC, or save them to its Downloads.
---

# Open on Desktop

ID: `file-local-open`. Small laptop and download icons appear beside supported
file links in thread messages. Laptop downloads to `~/Downloads/BB Files/open-*/`
and opens the system app; HTML uses Google Chrome. Download saves without launching
straight into `~/Downloads/` (Finder-style `name (2).ext` on collision; HTML with
assets goes into its own `~/Downloads/<name>/` folder) and reveals the file in Finder.
PDF links also offer “PDF — по ширине / на Mac”: page-width preview without thumbnails,
zoom selector, Open on Mac and Save to Downloads.

The target computer must be connected. `bb plugin config file-local-open set macHostId <host-id>`
selects it (macOS or Windows; the key keeps its first name). An empty setting selects the
single connected macOS host, or without a Mac the single connected Windows host.
Do not silently choose another computer when several are connected.
On Windows the file opens through the shell's default application for its type, HTML in the
default browser. When the file already is on the target computer, "open" starts the original
file and makes no copy; "save" still copies it to Downloads.

RPC `open` accepts `{path, source:{kind,threadId,environmentId,projectId,
experimental_hostId?}, action:"open"|"save"}`. Source follows the SDK file opener.
Use `bb plugin rpc inspect file-local-open open --json` for the current schema.
Use `bb plugin rpc call file-local-open open --input-file <file> --json` to execute.
Never put file contents in logs. Host RPC transfers bytes through BB, without SSH
configuration or a public file share. Each save gets a fresh directory; originals
and earlier local copies are preserved.

Supported: PDF, HTML, Office/OpenDocument, Markdown/text/CSV/JSON, common images,
audio/video and ZIP. Max 20 MiB and 100 files per operation. For HTML, relative
src/href/poster, CSS url() and @import resources under the HTML directory are
copied recursively. Remote URLs are left intact; missing assets, paths escaping
the directory and symlinks escaping it produce an error. Dynamic module imports,
fetch(), srcset and resources needing an HTTP server are not bundled. Opening
such HTML via file:// may require a server. The plugin does not make an HTML app
self-contained. All operations explicitly target the configured enrolled Mac,
even if clicked from a browser on another device.

Restore: `bb plugin build plugins/file-local-open`, then
`bb plugin install path:<absolute-checkout>/plugins/file-local-open --yes` on the
BB server host; restore macHostId for the new installation. To update a path
installation, build and `bb plugin reload file-local-open`. If an extension is
pinned to another viewer, select this viewer in Settings → File openers.
