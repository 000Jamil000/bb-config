import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, KeeperStatus } from "./server";

function useStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<KeeperStatus | null>(null);
  const refresh = useCallback(() => { rpc.call("status").then(setStatus).catch(() => {}); }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("status", refresh);
  return status;
}

function Notice() {
  const status = useStatus();
  useEffect(() => {
    if (status?.state === "attention") toast.warning(status.message, { id: "voice-mode-compatibility", duration: 15_000 });
    else toast.dismiss("voice-mode-compatibility");
  }, [status]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "update-status", component: Notice });
  app.slots.settingsSection({ id: "update-status", title: "Сохранение настроек Voice Mode", component: () => {
    const status = useStatus();
    return <p role="status">{status?.message ?? "Проверяю…"}</p>;
  }});
});
