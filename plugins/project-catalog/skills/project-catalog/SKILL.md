---
name: project-catalog
description: Find a BB project by meaning (aliases, Russian names, tags, description), read or update its catalog card, and check whether its copies on different machines are in sync, with `bb catalog`.
---

# Project Catalog

BB itself stores only a project's name, git remote and folders. This plugin
keeps one central card per project on the BB server: a short description, the
user's notes, category, tags, aliases, links and status, plus the last known
state of every folder of the project on every machine. The same data backs the
**Проекты** tab.

Use the CLI. It prints a few compact lines, so there is no need to load the
whole project list into context.

## Find a project

```sh
bb catalog find манибокс            # Russian spelling finds "Moneybox"
bb catalog find бот калории --limit 5
bb catalog list --category "Продукты"
bb catalog list --machine Tru --attention
bb catalog show <id|name|alias>     # full card; defaults to the current thread's project
bb catalog categories              # with the sidebar group of each
bb catalog group "Продукты" "Работа" # put a category into a group; omit the group to remove it
```

A project may have up to four categories: pass them comma-separated to
`--category`, the first is primary.

`find` matches names, aliases, tags, category, description, notes and folder
paths; every query word must match. Add `--json` for scripts. When the user
names a project loosely ("проект Манибокс"), run `find` first and use the
returned `proj_…` id with other `bb` commands.

## Describe a project (automatic)

```sh
bb catalog describe [project] --summary "1–2 предложения" --category "Категория" \
  --tags "a,b,c" --aliases "как называют вслух, русские написания" --links "Прод=https://…"
```

`describe` is the agent's write path. It never overwrites a field the user
edited by hand and reports which fields it kept. It never touches the user's
notes. Prefer a category that already exists (`bb catalog categories`).

A thread is asked to run `describe` once when its project has no card, or when
the project's README/AGENTS.md/CLAUDE.md changed and the card is older than 14
days. Nothing runs in the background and no model is called by the plugin.

## Edit on the user's behalf (manual)

```sh
bb catalog set <project> --notes "…" --status paused
bb catalog set <project> --summary "текст пользователя"   # locks summary against describe
bb catalog unlock <project> --fields summary,category      # let describe update them again
```

Use `set` only when the user dictates the text. Fields changed by `set` (or in
the tab) become locked; `--notes` and `--status` are always the user's.

## Copies on machines

```sh
bb catalog sync                 # every project that needs attention
bb catalog sync <project> --refresh
```

The check is read-only: it never fetches, commits, copies or deletes.

- git folder: branch, HEAD, uncommitted and untracked files, unpushed commits,
  commits behind the last fetched upstream, stash.
- folder without git: file count; when the project has folders on two
  machines, their contents are compared by hash and differing files are listed
  with the side that is newer.

Levels: `Расходится` (copies on machines went apart and work could be lost),
`Нужно внимание` (uncommitted or unpushed work, a missing folder, different
commits), `Не проверено` (machine offline or never scanned). A folder without
git on a single machine is a normal state.

Limits: an offline machine shows its last known state with its age. "Behind"
uses the refs from the last `git fetch`. Folders are walked to depth 10 and
4000 files, skipping dependency and build directories; files over 2 MiB are
compared by size. Scans run every three hours, when the tab opens with data
older than 30 minutes, and on demand.

A git repository nested in a folder without git is reported by its own git
state (shown under the folder as `<path>/ — свой git …`) and is not hashed.

When copies on two machines are separate on purpose, the user can mark them
in the card, or run `bb catalog set <project> --independent yes`; they are then
not compared. When only some sub-folders are meant to differ on every machine,
run `bb catalog set <project> --local-paths "folder-a,folder-b"` (relative to
the project root; an empty string clears the list). Unsaved git work inside a
local folder is still reported. Do either only on the user's word.

The plugin does not synchronise copies. To reconcile a diverged project, read
`bb catalog sync <project>`, agree the direction with the user, and copy files
with the usual tools.
