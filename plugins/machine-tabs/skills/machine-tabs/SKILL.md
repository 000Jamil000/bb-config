---
name: machine-tabs
description: Switch the sidebar's machine tab (filter bb's thread list to one machine, or all) with `bb machine-tabs`.
---

# Machine tabs

The Machine Tabs plugin is a sidebar thread list (Settings → Appearance →
Sidebar: "Thread list + machine tabs"). It renders bb's own thread list and
adds, above it:

- Machine tabs: a tab filters the list to that machine's threads. The selected
  tab is stored on the server and synced to every window.
- A layers button: Group by / Then by (Project, Machine, Day, None) and Sort
  (Last updated, Created, Name). One level is bb's own grouping; with two
  levels the plugin draws the first and repeats bb's list inside each group.
  Day sections are the plugin's, not bb sections.
- A filter field: matches thread titles and group headers (project, machine,
  day), ignoring case and a wrong RU/EN keyboard layout.
- A "Last 5" block: the five most recently updated threads, which also stay
  in their own groups. Parent/child links are preserved, so BB’s original
  expand/collapse controls, child rows and activity indicators also work here.

Project groups automatically sort by their latest visible thread's `updatedAt`
(newest first), including nested projects and projects used as the outer group.
New activity recomputes the order. Empty projects remain at the bottom; ties
keep BB's existing project order. This does not change thread row sorting or
the order of machine/day groups. Last 5 stays above the main list.

Threads in a project show its two-letter badge before the title, except when
the list is grouped by project.

- `bb machine-tabs list` — machines; `*` marks the active tab.
- `bb machine-tabs select <machine-id|all>` — switch the tab.

Switch back to bb's plain list with
`bb settings ui set sidebar.threadListProvider '"thread-list/thread-list"'`.

## Project images

A thread row and a project header show the project's mark: two letters, or
the project's own image when its root holds one of `.bb/icon.png`,
`.bb/icon.svg`, `favicon.png`, `favicon.svg`, `favicon.ico` (first found, up
to 256 KB). Images are drawn grey. They are re-read every five minutes;
`bb machine-tabs icons` re-reads them now and lists the projects that have one.
