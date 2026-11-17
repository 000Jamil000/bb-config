import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountSetupShortcut } from "./shortcut.ts";

export default definePluginApp(app => {
  app.contentScripts.register({
    id: "setup-next-to-submit",
    mount: ({ signal }) => mountSetupShortcut(document, signal),
  });
});
