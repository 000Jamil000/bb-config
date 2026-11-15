# Voice Mode Keeper

Automatically preserves the managed Voice Mode catalog installation's personal
customizations. It does not create a fork or supply a voice model.

Every 30 seconds and after startup it detects a changed installed release,
waits for BB's update job to finish, validates the exact source edits in an
isolated copy, runs regression tests and TypeScript, builds, then reloads.
No network package installation happens during validation. The original
catalog release is left untouched if compatibility checks fail. Failed
activation restores the original source/bundle; a journal handles interrupted
activation on the next check. A visible notification and the plugin settings
page report incompatible releases.

The voice, connection mode and other explicitly allowlisted nonsecret
preferences are preserved across releases. Credentials are never accessed or
copied. Same-install preferences changed by the user take precedence over the
cached values. Disabled Voice Mode is not re-enabled.
After successful preservation it updates the private bb-config snapshot.

Automatic forward application is limited to 0.1.x (0.1.15+) and exact, unique
source anchors. New APIs or failed checks require adapting the patch, rather
than forcing it. This is a tested compatibility layer, not a guarantee about
arbitrary future upstream versions.

Restore from bb-config with `python3 scripts/restore.py --plugins --apply`.
The sibling `plugins/voice-mode` patch directory must remain alongside this
plugin. `npm ci` installs the pinned validation toolchain. No manual reapply
is needed for compatible updates. Inspect `bb plugin rpc call
voice-mode-keeper status --json` and the settings page for the current state.

On a different server, configure the path to its official CLI once:
`bb plugin config voice-mode-keeper set cliPath "$(command -v bb)"`.
The current server's path is stored only in the private settings snapshot.
This is needed because a BB service's PATH need not include the CLI. It is
unrelated to the voice provider's authorization; no credentials are accessed.
