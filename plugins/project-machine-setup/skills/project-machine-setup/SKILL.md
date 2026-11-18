---
name: project-machine-setup
description: Explain or troubleshoot the project setup shortcut beside a blocked new-thread submit button.
---

# Project setup shortcut

When a project has no checkout on the selected machine, **Подключить проект** next to the disabled Enter button opens BB's native setup form. Choose clone from Git or an existing folder and review the target path. The draft and selected machine are preserved; setup does not submit the prompt.

For diagnostics inspect `bb plugin list --json` and `bb project show <id> --json`. The companion is frontend-only. It targets BB 0.49's new-thread composer DOM and native English `Select an environment.` / `Set up on …` labels. It supports compact layout, disposes observers on unload, and never changes a project source itself. If the shortcut is unavailable, use **Environment → Set up on <machine>…**. Do not patch BB core or duplicate its setup form.

Project clones do not contain ignored files, uncommitted changes, nested repositories excluded from Git, or terminal agent histories. Check those separately before claiming a complete transfer.
