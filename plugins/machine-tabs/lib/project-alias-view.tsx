import { createElement, Fragment, useMemo } from "react";
import { projectAliases, type LinkedThread } from "./project-aliases";

type Props = Record<string, any>;

/** Extend native project contents while keeping the original tree and DnD.
 * Alias rows use the native non-sortable renderer: dragging a second visual
 * occurrence must not reparent the underlying session by accident.
 */
export function withProjectAliases(runtime: Props, useVisibleThreads: () => readonly LinkedThread[]) {
  const base = "default" in runtime ? runtime.default : runtime;
  function ProjectContents({ Component, nativeProps }: Props) {
    const threads = useVisibleThreads();
    const existing = nativeProps.threadListState.threads ?? [];
    const aliases = useMemo(() => projectAliases(threads, nativeProps.projectId, existing),
      [threads, nativeProps.projectId, existing]);
    if (aliases.length === 0 || nativeProps.threadListState.status !== "ready") {
      return createElement(Component, nativeProps);
    }
    return createElement(Fragment, null,
      existing.length ? createElement(Component, nativeProps) : null,
      createElement("div", { "data-machine-tabs-project-aliases": nativeProps.projectId },
        createElement(Component, {
          ...nativeProps, rootItems: undefined, dndParentKey: undefined,
          threadListState: { status: "ready", threads: aliases },
        })),
    );
  }
  const wrap = (factory: any) => (type: any, props: Props, key: any) => {
    const projectContents = typeof type !== "string" && props &&
      typeof props.projectId === "string" &&
      props.dndParentKey === `project:${props.projectId}` &&
      props.threadListState && typeof props.onToggleThreadCollapsed === "function" &&
      "rootItems" in props && !props.project;
    return projectContents
      ? factory(ProjectContents, { Component: type, nativeProps: props }, key)
      : factory(type, props, key);
  };
  const wrapped = { ...base, jsx: wrap(base.jsx), jsxs: wrap(base.jsxs) };
  return "default" in runtime ? { ...runtime, ...wrapped, default: wrapped } : wrapped;
}
