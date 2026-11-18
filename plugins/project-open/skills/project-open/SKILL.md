---
name: project-open
description: Diagnose Project Open’s Finder folder buttons and original BB terminal shortcuts.
---

Project Open registers folder and terminal actions in BB’s native thread menu.
Use … → Customize actions or the thread-list preference `rowActions` to choose
up to three row shortcuts. The keys are `project-open/open-folder` and
`project-open/open-terminal`. An empty array leaves only the overflow menu.
Header buttons show the machine and full path. On mobile use BB’s native files UI.
Resolve host/path from the selected thread’s environment, never a project source.
Header scope comes from the real thread composer; never infer a thread from
only the URL when split panes are open.

With `finderHelper` enabled, folders use the local macOS `BB Project Folder.app`
application-link handler. It opens local paths directly and mounts configured
remote roots through existing rclone/OpenSSH and native WebDAV, bound to loopback.
It does not use Cyberduck or NFS, and does not click the adjacent Open chooser.
Windows/phones need their own opener; the macOS handler must not be reported as
working on those platforms.

Read README.md and macos/ sources before changing the handler. Keep machine
mappings in private config. Never save keys, credentials, runtime status, caches
or application-link authorization state in public source.

A passing test requires one actual activation, the correct host/path in the
handler status, and verification that Finder shows that mounted path. A menu
opening or a successful mount/stat alone does not prove the folder opened.
Check repeated clicks and native menu state; do not report a stale failed request
as the outcome of a newer successful one.
