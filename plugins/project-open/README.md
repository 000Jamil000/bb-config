# Project Open

Two folder/terminal icons on project rows and thread headers. Desktop controls
appear on hover or keyboard focus; their space is reserved so BB’s controls do
not move. The new icons precede native Open; native Open and the panel toggle
remain adjacent. BB’s sidebar renderer and menus are preserved.

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

Rebuild/reload Machine Tabs too: it adds `data-machine-tabs-host-id` to existing
containers so repeated project names select the correct source machine.
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
