# Project Open

Folder and terminal actions are available in the thread’s native **…** menu. Choose **Customize actions** in that menu to show up to three shortcuts on a row. BB stores the selection in the thread-list preference `rowActions`. The bb-config default is an empty list. The plugin action keys are `project-open/open-folder` and `project-open/open-terminal`.

The open thread’s header also shows both buttons with machine and folder tooltips.

The terminal uses BB’s original New tab → Start terminal, scoped to the thread
pane or the selected project host. No separate terminal or SSH UI is implemented.

## Finder on macOS

The optional local `BB Project Folder.app` handles `bb-project-folder://` links.
A local project opens directly in Finder. A remote project is exposed by the
**already installed rclone**, using the existing OpenSSH profile, over WebDAV
on the loopback interface. macOS’s own `mount_webdav` connects the disk; Finder
opens the exact requested directory. No FUSE driver, remote network share,
SSH key copy or new server-side authentication is required. NFS is not used.

The handler accepts only configured host IDs and allowed project roots. The
link carries a host ID, path and request ID, without SSH addresses or credentials.
Configuration and runtime status stay under the client’s
`~/Library/Application Support/BB Project Folder/`, outside this repository.

Source: `macos/open_folder.py`, `macos/handler.applescript`, `macos/install.py`.
Create a private JSON config containing the installed `rclone` path and `hosts`:

```json
{
  "rclone": "/path/to/rclone",
  "hosts": {
    "<local-host-id>": {"mode": "local", "roots": ["/path/to/projects"]},
    "<remote-host-id>": {"mode": "sftp", "sshProfile": "existing-ssh-alias",
      "root": "/remote/projects", "label": "Remote projects", "readOnly": false}
  }
}
```

On the Mac, copy all three source files to one directory, then run:

```sh
python3 macos/install.py --config /private/path/client.json
```

The installer compiles/registers the native app in `~/Applications/`. After
verifying it, enable `finderHelper` in Project Open’s BB settings. BB may ask
for permission to open this application-link scheme on the first click; use
its normal approval UI. The helper is macOS-specific; it does not add a Finder
handler to Windows or phones. Without it the fallback requires BB to offer
Finder/File Manager in its native workspace chooser; unsupported remote folders
produce an explanation rather than silently leaving the neighbour’s menu open.

## Restore and verify

```sh
npm ci --include=dev
npm test
npm run typecheck
python3 -m unittest discover -s macos -p 'test_*.py'
bb plugin build .
bb plugin install . --yes
```

Sidebar controls use the row’s thread ID and resolve its environment at activation,
including its host and worktree. Project groups have no folder/terminal shortcuts.
Machine Tabs is not required for resolving a folder.
Header controls are mounted from the thread’s composer banner scope, then
portalled to its own header. They use the actual thread ID even in split panes.
DOM markers and accessible labels must be rechecked after BB UI updates.
Unmount removes portals/observers and aborts pending UI operations.

To disconnect the remote disk use Finder’s eject action or
`diskutil unmount <handler-support-dir>/Volumes/<label>`. Runtime logs/status
and cached files must not be committed or copied into the settings snapshot.
The handler’s private config must be restored separately; see the repository’s
private customization notes. Disabling the plugin removes the icons without
replacing BB’s original controls.

Connection lifecycle: the macOS helper starts rclone on demand, without a
LaunchAgent. Each configured remote host reuses its existing local server and
mount. After reboot the next activation creates the connection again; it does
not automatically restore Finder windows. Network/VPN interruptions have no
helper watchdog or guaranteed transparent recovery. An unreachable SSH target
requires restored connectivity and may require ejecting/reopening the disk.
The helper neither provides a VPN/proxy route nor maintains an offline project
copy. Every remote host needs an explicit private SSH/root mapping.

On iPhone/iPad/Android the folder action opens BB’s
original New tab file search for that thread, never the macOS URL handler.
The macOS handler is used only on a Mac desktop; other desktop clients use
BB’s native Open behavior.
