# Open on Mac

A small companion plugin for BB: compact laptop and download icons beside
file links in chat. The first copies a server file to Mac Downloads and opens
its default app (HTML explicitly uses Chrome); the second only saves it.
Includes a PDF preview fitted to panel width, without the thumbnail sidebar.

Sources remain on their owning machine. Copies go to fresh directories under
`~/Downloads/BB Files/`; SHA-256 verifies bytes. No fork of BB or a bundled plugin.
Uses the supported content-script, composer, file-opener and host RPC APIs.

See [usage and restoration](skills/file-local-open/SKILL.md) for limits and commands.

Validation: `npm ci`, `npm run typecheck`,
`node --experimental-strip-types --test files.test.mjs`, `bb plugin build .`.
