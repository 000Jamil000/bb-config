import { useEffect, useRef, useState } from "react";
import { definePluginApp, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { openOriginalHandoff } from "./open-original";

function HandoffButton() {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => pending.current?.abort(), []);
  return <button type="button"
    className="inline-flex h-7 items-center gap-1 rounded px-2 text-sm hover:bg-state-hover disabled:opacity-50"
    title="Open the original Handoff panel" aria-label="Open Handoff in sidebar" disabled={busy}
    onClick={(event) => {
      const controller = new AbortController();
      pending.current?.abort(); pending.current = controller; setBusy(true);
      void openOriginalHandoff(event.currentTarget, controller.signal)
        .catch((error) => { if (!controller.signal.aborted) toast.error(String(error.message ?? error)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }}><Icon name="ArrowTurnForward" className="size-3.5" /><span className="max-md:hidden">Handoff</span></button>;
}

export default definePluginApp((app) => {
  app.composer.customize({ id: "handoff-button", scopes: ["thread"],
    actions: [{ id: "handoff", component: HandoffButton }],
  });
});
