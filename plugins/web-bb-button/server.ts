import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { webTarget } from "./target.ts";

export default async function webBbButton(bb: BbPluginApi) {
  const settings = bb.settings.define({
    webUrl: { type: "string", label: "Публичный адрес BB", default: "" },
  });
  const configurationMessage = "Укажите публичный адрес BB в настройках Web BB Button (например, https://example.getbb.app).";
  function configured(webUrl: string): boolean {
    try { webTarget(webUrl, bb.server.experimental_appUrl); return true; }
    catch { bb.status.needsConfiguration(configurationMessage); return false; }
  }
  const initial = await settings.get();
  if (!configured(initial.webUrl)) return;
  settings.onChange((next) => { configured(next.webUrl); });
  bb.http.route("GET", "/open", async (context) => {
    const { webUrl } = await settings.get();
    try {
      return context.redirect(webTarget(webUrl, bb.server.experimental_appUrl), 302);
    } catch {
      return context.text("Укажите корректный HTTP(S) адрес без логина и пароля в настройках Web BB Button.", 503);
    }
  });
}
