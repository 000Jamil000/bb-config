# Push Button

Adds a compact Пуш button immediately after the existing branch control in a
thread composer footer. Clicking sends the plain user message `пуш` to that
composer’s thread through `sdk.threads.send`, using `queue-if-active`.
The button never executes Git, changes permissions or edits the composer draft.
The agent handles review, commit and push as a normal user request. Repeated
clicks while the send is pending are ignored. Errors use the standard toast.

This is a separate plugin; it preserves BB’s branch and changes controls.
It mounts through a scoped composer banner and portals beside the branch.
Disabling the plugin removes its button and observer. BB DOM markers must be
rechecked after UI updates. No button appears in new-thread or message editors.

Restore with `python3 scripts/restore.py --plugins --apply`, or run `npm ci`,
`bb plugin build .`, and `bb plugin install path:<absolute-plugin-directory> --yes`.
Verify with `npm run typecheck` and `npm test`.

The button is disabled and muted while Git is loading/unavailable or there is
nothing to send. A read-only host entry runs `git status --porcelain=v2 --branch
--ahead-behind` in the thread environment with optional locks disabled. It
recognizes modified/untracked files, commits ahead of the actual upstream,
and the first publication of an existing local branch. It does not fetch.
Tracking refs reflect the last fetch/push. Status refreshes every 5 seconds
only while the button’s RPC read is watched; closing the UI stops the timer.
The host read neither commits nor pushes; a click still only sends `пуш`.

On touch screens up to 640 px wide, Push sits beside the existing Changed
files control when present, otherwise beside the branch. Its label remains
visible and the touch target is 44 px tall. Pointer down preserves composer
focus, so collapsing the draft does not remove the target before click.
Desktop placement remains beside the branch.
