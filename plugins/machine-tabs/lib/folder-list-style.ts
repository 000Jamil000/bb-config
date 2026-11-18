/** Compact folder navigation; native rows keep their actions and tree semantics. */
const folder = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2"/><path d="M3 8h17a1 1 0 0 1 1 1.4l-3.2 9a2 2 0 0 1-1.9 1.3H4.6a2 2 0 0 1-2-1.8L2 9a1 1 0 0 1 1-1Z"/></svg>')}")`;
export const FOLDER_LIST_CSS = `
[data-machine-tabs-list] div.space-y-4 { gap: 12px; }
[data-machine-tabs-list] [data-sidebar="group-label"] {
  min-height:32px; padding-left:8px; font-size:13px; line-height:20px;
  font-weight:500; letter-spacing:0; color:var(--sidebar-foreground);
}
[data-machine-tabs-list] [data-sidebar="group-label"] > span:first-child { gap:6px; }
[data-machine-tabs-list] [data-sidebar="group-label"] > span:first-child::after { content:none; }
[data-machine-tabs-list] [data-sidebar="group-label"] > span:first-child::before {
  width:18px; height:18px; margin-right:2px; border-radius:0; opacity:.8;
}
[data-machine-tabs-list] [data-sidebar-visibility-group^="section:sec_"] [data-sidebar="group-label"] > span:first-child::before {
  content:""; background:currentColor; mask:${folder} center / 18px no-repeat;
  -webkit-mask:${folder} center / 18px no-repeat;
}
[data-machine-tabs-list] [data-sidebar="group-label"] + div {
  margin-left:24px; padding-left:0; border-left:0;
}
[data-machine-tabs-list] .bb-thread-title:has(> [data-machine-tabs-badge="topic"]) {
  min-height:30px; font-size:13px; line-height:20px;
}
[data-machine-tabs-list] .machine-tabs-topic-mark {
  width:16px; height:18px; margin-right:6px; border-radius:0;
  background:transparent; box-shadow:none; opacity:.8;
}
[data-machine-tabs-list] .machine-tabs-topic-mark svg { width:15px; height:15px; }
[data-machine-tabs-list] [data-sidebar-rename-row] { border-radius:8px; }
/* Header controls retain their native hover, focus, and touch behavior. */
`;
