# Voice Mode customizations

Reviewed source edits for upstream Voice Mode 0.1.15. This directory is a
reproducible patch, not a replacement plugin. The installed plugin stays on its
catalog Git source. Voice Mode Keeper automatically validates and restores the
edits after compatible updates. A changed API or failed validation leaves the
original release available and reports a compatibility warning.

Changes:

- Russian first-person speech, without describing a separate agent to the user.
  This also covers work-tool descriptions, acknowledgments, results and status
  reports: one conversational identity, accurate results, no delegation narration.
  Direct questions about architecture must still be answered truthfully.
- A compact waveform button beside the native microphone starts Voice Mode
  from the new-thread screen, including phone layouts. No full-width banner is
  shown. It creates a normal visible thread with the selected
  project, environment/machine, provider, model and permissions, sends a brief
  readiness-only setup message, then opens voice and navigates to that thread.
  It never replaces a nonempty draft; the button is disabled until the draft is
  sent or cleared. Navigating away while creation is pending prevents a delayed
  microphone activation. The setup uses the existing agent allowance.
  Its placement helper follows composer rerenders and releases its observer
  and portal on unmount; the fallback is also a compact button.
- A random short Russian greeting from 30 serious and playful phrases after
  the client microphone and audio player are ready. The previous phrase is
  excluded during the lifetime of the loaded plugin (a reload resets it).
  This includes stopping and starting again. No tools or thread context in
  that greeting; no greeting over a user who has already begun speaking.
- Preserve the native dictation button when BB puts it in the mobile submit
  group. During a live session the existing pill still owns the microphone;
  end the conversation before recording an ordinary audio message.
- Server speech detection with a higher threshold, noise reduction, Russian
  transcription, and a 900 ms pause before answering. Remove the local
  amplitude-only playback interruption, which could mistake noise for speech.
  Intentional interruptions still use the server's speech-start event.

Inspect/apply on the machine running the BB server:

```sh
python3 plugins/voice-mode/apply.py
python3 plugins/voice-mode/apply.py --apply
python3 scripts/snapshot.py --settings-only
python3 scripts/snapshot.py --check
```

Applying rebuilds/reloads the managed plugin and ends any current voice session.
Changed source and bundles are backed up under ignored `.local/plugin-patches/`;
build/reload failures restore that backup. No credentials or audio are copied.
The manual script refuses unknown versions/ambiguous edits. Normal compatible
catalog updates are handled by the keeper, using `auto_update.py` in staging;
no manual reapply is needed. Incompatible source contracts still require
adapting `changes.json`. To remove the customizations, disable the keeper, then reinstall the
original `voice-mode` catalog entry and keep the existing subscription settings.

New settings (next session): `vadThreshold` (default 0.7),
`silenceDurationMs` (900), `noiseReduction` (`far_field` for a phone/laptop;
`near_field` for a headset). Lower the threshold if quiet speech is missed.
Noise reduction cannot guarantee rejection of nearby voices or television.
The general restore skips these three keys until the patch is installed.
`apply.py --apply` restores their saved values from the private snapshot, even
when the source edits are already present.

The selected voice is saved in the private plugin settings (currently
`shimmer`, changed from `marin`). ChatGPT's Juniper is not among this Realtime
connection's supported voices; no exact mapping is claimed. Speech instructions
request natural, calm Russian conversation without announcer-like intonation.

`changes.json` also carries regression tests appended to the upstream backend
suite: readiness, repeated readiness, speaking before readiness, tool-free
greeting, and speech configuration. Verify in an isolated copy with upstream's
dev dependencies using `npm test` and `npm run typecheck` before applying.
`mobile-check.js` is a Browser Automation fixture at 390 px: dictation remains
visible while idle, is owned by the live voice pill during a session, and
returns when the session ends. This fixture is not a signed-in mobile device
test. The upstream suite plus added regressions passes 51 tests, including
30 unique greetings and exclusion of the last choice. A live
subscription check accepted the noise settings and returned the spoken phrase
«Я готов. Что сделать?» without provider errors.

The keeper preserves only allowlisted nonsecret preferences, waits for BB's
update job to finish, and validates upstream tests, types and build before
activation. It uses the pinned toolchain in `plugins/voice-mode-keeper`, so
ordinary updates do not download dependencies. Rollback and restart recovery
are tested by `test_auto_update.py`; the original source is not modified when
staging checks fail. After successful checks the private snapshot is refreshed.

Upstream code excerpts in the patch remain under the MIT license; see
[UPSTREAM_LICENSE](UPSTREAM_LICENSE).
