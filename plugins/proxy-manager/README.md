# Proxy Manager

Named HTTP/HTTPS proxies, per-machine connectivity checks, and native Codex routing.

Choose a proxy or Direct for Codex on a connected machine. This stops that machine's
BB Codex runtimes with the SDK, preserves sessions, and updates the machine user's
`CODEX_HOME/.env` and `config.toml`. The next message resumes using the new settings.
All Codex sessions sharing this home are affected, including future external CLI
launches; already-running external CLI processes are not controlled by BB.
This is not per-account isolation. Claude settings and runtimes are not changed.

Native configuration sets both proxy variable casings and disables
`features.system_proxy_fallback` and `features.respect_system_proxy`. Direct mode
sets empty proxy variables and NO_PROXY=*. Native configuration is backed up under
`CODEX_HOME/.bb-proxy-backups/<id>/original.json` (private permissions).
Unrelated config values/comments are preserved; unsupported TOML layouts are refused.
Existing nonempty proxy variables inherited by the BB host worker are refused because
they can take precedence over Codex's dotenv. Default/home-based Codex execution is
supported; separate account-specific CODEX_HOME overrides are not provisioned here.

During switching, the standard BB dispatch hook holds Codex messages. An unconfirmed
stop or failed write leaves requests waiting, with an error; reapply in settings.
Changing managed routing values outside the plugin also holds later submissions until
reapplication. Other model settings can still change normally. Core owns retry and
queue behavior; this plugin does not resend prompts or proxy model APIs.

The composer shows a network icon, gently animated status dot, proxy name, optional warning, and a settings gear visible on hover/focus (always on touch screens). Motion respects reduced-motion settings.
A server-side monitor checks each applied Codex connection every 30 seconds, without model credentials. After the initial/full manual check, heartbeat checks only OpenAI reachability; IP metadata is refreshed by a full manual check. Concurrent checks for the same host/route share one request. The monitor stops with the plugin.
The settings page leads with machine connections, hides unused CLI controls, and adds proxies through a dialog.
Hover/focus labels carry details. Green means a recent connectivity check, not proof
of account authentication or OS-level isolation. No BB application files are patched.
CLI routing was tested with Codex 0.167.2; future CLI/BB versions need revalidation.

Commands:
- `bb proxy-manager list`
- `bb proxy-manager import <name> <absolute-file>` (Host/Port/Username/Password)
- `bb proxy-manager check <host-id> <proxy-id|direct>`
- `bb proxy-manager prepare <host-id> <proxy-id|direct>` (read-only preflight)
- `bb proxy-manager apply <host-id> <proxy-id|direct>` (stops Codex threads)
- `bb proxy-manager arm <thread-id> <host-id> <proxy-id|direct>` (initial activation after that thread becomes idle)
- `bb proxy-manager remove <proxy-id>`

Build: `npm run check`, `npm test`, `bb plugin build`.
See TEST_RESULTS.md for the original integration correction and subsequent native tests.
