import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { definePluginApp, ThreadChat, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { attachLayout, CSS, inspect, threadInWorkspace } from "./inspector";
type Attachment = ReturnType<typeof attachLayout>;
function Inspector() {
  const rpc = useRpc<typeof rpcContract>();
  const threadId = useSyncExternalStore(
    subscribeToRoute,
    currentThread,
    () => null,
  );
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    rpc.call("config", null).then(
      (config) => {
        if (active) setEnabled(config.enabled);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  return enabled && threadId ? (
    <Workspace key={threadId} threadId={threadId} />
  ) : null;
}

function currentThread() {
  return threadInWorkspace(location.pathname);
}

function subscribeToRoute(check: () => void) {
  const navigation = (window as Window & { navigation?: EventTarget })
    .navigation;
  navigation?.addEventListener("currententrychange", check);
  window.addEventListener("popstate", check);
  const timer = navigation ? undefined : window.setInterval(check, 250);
  return () => {
    navigation?.removeEventListener("currententrychange", check);
    window.removeEventListener("popstate", check);
    window.clearInterval(timer);
  };
}

function Workspace({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [paused, setPaused] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [mode, setMode] = useState<"chat" | "code">("chat");
  const [warning, setWarning] = useState("");
  useLayoutEffect(() => {
    if (paused) return;
    let mounted: Attachment | null = null;
    let root: HTMLElement | null = null;
    let editors: HTMLElement | null = null;
    let frame = 0,
      lastReport = "",
      started = Date.now();
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    const select = (next: "chat" | "code") => {
      mounted?.mode(next);
      setMode(next);
    };
    const dispose = () => {
      mounted?.dispose();
      mounted = null;
      root = null;
      editors = null;
      setAttachment(null);
    };
    const report = (
      state: "compatible" | "incompatible" | "waiting",
      reason: string,
    ) => {
      const signature = state + reason;
      if (signature === lastReport) return;
      lastReport = signature;
      rpc.call("report", { state, reason }).catch(() => {});
    };
    const scan = () => {
      frame = 0;
      if (currentThread() !== threadId) {
        if (mounted) dispose();
        setWarning("");
        started = Date.now();
        return;
      }
      const result = inspect(document, (e) => e.getClientRects().length > 0);
      if (result.state !== "compatible") {
        if (mounted) dispose();
        const reason =
          result.state === "waiting" && Date.now() - started > 15000
            ? "KodaForge не загрузился. Проверьте, включён ли основной плагин."
            : result.reason;
        setWarning(
          result.state === "incompatible" || Date.now() - started > 15000
            ? reason
            : "",
        );
        report(result.state, reason);
        return;
      }
      setWarning("");
      if (
        mounted &&
        (editors !== result.editors ||
          mounted.original !== result.original ||
          !mounted.toolbar.isConnected ||
          !mounted.chat.isConnected)
      )
        dispose();
      if (!mounted) {
        root = result.root!;
        editors = result.editors!;
        mounted = attachLayout(editors, result.original!);
        setAttachment(mounted);
        setMode("chat");
      }
      report("compatible", result.reason);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(scan);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "id"],
    });
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        currentThread() !== threadId ||
        !root ||
        !target ||
        !root.contains(target)
      )
        return;
      const button = target.closest("button");
      const label = button?.getAttribute("aria-label") ?? "";
      if (
        label === "Chat" ||
        label.startsWith("Toggle Chat") ||
        button?.textContent?.includes("Chat with an agent")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select("chat");
        return;
      }
      if (target.closest('[data-panel][id="sidebar"]')) select("code");
    };
    const key = (event: KeyboardEvent) => {
      if (currentThread() !== threadId) return;
      if (
        root &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "p"
      )
        select("code");
      if (
        root &&
        root.contains(event.target as Node) &&
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select("chat");
      }
    };
    // A slow heartbeat detects route changes even when BB retains DOM panes.
    const timer = window.setInterval(schedule, 1500);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("popstate", schedule);
    scan();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearInterval(timer);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("popstate", schedule);
      mounted?.dispose();
      style.remove();
    };
  }, [paused, rpc, threadId]);
  const choose = (next: "chat" | "code") => {
    attachment?.mode(next);
    setMode(next);
  };
  return (
    <>
      {attachment &&
        createPortal(
          <div className="kfi-toolbar">
            <button
              aria-pressed={mode === "chat"}
              onClick={() => choose("chat")}
            >
              Чат с ИИ
            </button>
            <button
              aria-pressed={mode === "code"}
              onClick={() => choose("code")}
            >
              Файлы и код
            </button>
            <small title="Отдельный плагин. Исходные файлы KodaForge не изменяются.">
              Инспектор ✓
            </small>
          </div>,
          attachment.toolbar,
        )}
      {attachment &&
        createPortal(
          <ThreadChat
            threadId={threadId}
            variant="full"
            layout="contained"
            permissionPolicy="editable"
            className="h-full min-h-0 flex-1"
          />,
          attachment.chat,
        )}
      {warning && (
        <div className="kfi-warning" role="status">
          {warning}{" "}
          <button
            onClick={() => {
              setPaused(true);
              setAttachment(null);
              setWarning("");
            }}
          >
            Отключить до выхода из редактора
          </button>
        </div>
      )}
    </>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "inspector", component: Inspector });
});
