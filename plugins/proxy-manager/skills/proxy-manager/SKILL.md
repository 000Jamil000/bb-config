---
name: proxy-manager
description: Inspect named proxies, machine connectivity and native Codex routing; apply a machine's Codex route using standard BB stops and native CLI configuration.
---

Use `bb proxy-manager list` for redacted settings and route state.
`bb proxy-manager check <host-id> <proxy-id|direct>` checks that machine's egress
and OpenAI endpoint reachability without account tokens. Green is connectivity only.

`bb proxy-manager apply <host-id> <proxy-id|direct>` stops BB Codex runtimes on that
machine and updates its user's CODEX_HOME/.env and config.toml. Sessions remain saved.
The next message resumes. Affects all Codex sessions sharing that home, not an
individual account. Already-running external Codex processes are not stopped.
Do not apply to Claude; the current implementation never changes its routing.

If applying to the machine running this thread, prepare and verify all work first;
use `arm <thread-id> <host-id> <proxy-id|direct>` as the last action to apply after
this answer ends. Otherwise apply would interrupt this thread too.

Routing disables system_proxy_fallback and respect_system_proxy. Host-inherited
proxy overrides or unsupported config layouts are refused. Backups are private
under CODEX_HOME/.bb-proxy-backups. A failed switch holds new Codex messages; fix
and reapply. A changed routing fingerprint also holds messages. Do not bypass
these waits or claim OS-level enforcement based on a connectivity check.

Credentials live in BB secret settings and the private native .env; never print
secrets or dump those files. No app artifacts are patched and no custom API gateway
is used. Version updates require native routing behavior to be revalidated.
