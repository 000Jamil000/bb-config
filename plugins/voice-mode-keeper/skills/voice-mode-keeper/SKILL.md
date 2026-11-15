---
name: voice-mode-keeper
description: Inspect automatic preservation of Voice Mode preferences after catalog updates, or diagnose a compatibility warning.
---

Voice Mode Keeper preserves the original catalog installation. It checks after
updates, stages exact source edits, runs upstream regression tests, typechecks
and builds before activation. It never enables a disabled Voice Mode or changes
credentials, subscriptions, API billing or routes.

Inspect: `bb plugin rpc call voice-mode-keeper status --json` and
`bb plugin logs voice-mode-keeper`. An attention state means the catalog plugin
remains available without unverified customizations. Do not claim all future
versions are compatible. The helper only attempts compatible 0.1.x releases;
changed source contracts or failed validation require adapting the patch.

Source and recovery: `plugins/voice-mode/auto_update.py`, `changes.json` and
the keeper plugin in the bb-config checkout. The worker uses pinned packages
from the keeper's node_modules, no network install during upgrades. Keep those
packages installed with npm ci when restoring. Test using
`python3 -m unittest discover -s plugins/voice-mode -p test_auto_update.py`.

Do not log or snapshot credential files, audio or conversations. The keeper
stores only a fixed allowlist of nonsecret preferences and compatibility status.
Its recovery journal and source/build backups are private ignored files.
