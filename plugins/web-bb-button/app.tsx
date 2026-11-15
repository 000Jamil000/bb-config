import { definePluginApp } from "@get-bb/plugin-sdk/app";

// The server resolves its configured public URL; no personal address in source.
const WEB_BB_URL = "/api/v1/plugins/web-bb-button/http/open";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "web-bb-rail-button",
    mount({ signal }) {
      const link = document.createElement("a");
      link.href = WEB_BB_URL;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Открыть BB в браузере";
      link.setAttribute("aria-label", link.title);
      link.dataset.bbPlugin = "web-bb-button";
      link.dataset.bbPluginRoot = "web-bb-button";
      link.dataset.webBbRailButton = "";
      link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-icon-root><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>';

      function attach() {
        if (signal.aborted) return;
        const item = document.querySelector<HTMLElement>("[data-nav-rail-item]");
        const rail = item?.parentElement;
        const template = item?.querySelector("button");
        if (!rail || !template) return;
        // Rail's final direct button is its More menu.
        const more = Array.from(rail.children).findLast(
          (child) => child.tagName === "BUTTON" && child.hasAttribute("aria-haspopup"),
        );
        if (link.parentElement === rail) return;
        link.className = template.className;
        link.style.textDecoration = "none";
        rail.insertBefore(link, more ?? null);
      }

      const observer = new MutationObserver(attach);
      observer.observe(document.body, { childList: true, subtree: true });
      attach();
      return () => {
        observer.disconnect();
        link.remove();
      };
    },
  });
});
