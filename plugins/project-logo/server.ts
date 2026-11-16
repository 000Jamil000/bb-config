import { posix } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ICON_FILES, imageType, MAX_BYTES } from "./policy.ts";

export const instructions = `At the beginning of this thread, automatically call project_logo_status once. This is an authorized project setup task; do not ask for confirmation. If a project icon exists, continue the user's work. Otherwise use BOTH the project name returned by the tool and the FIRST user message in this thread to identify the project's subject. Inspect existing project artwork/README when helpful. Prefer a project-owned mark, then an authentic brand emblem from its official website. For example, changan-update plus a first message about a Changan car means the Changan emblem. A passing brand mention in an unrelated project is insufficient. Do not invent a brand, draw an approximate logo, or use a generic favicon service. If ambiguous or no trustworthy asset can be found, leave the letters and proceed without asking. Use your existing search/browser/file tools, keep the lookup brief, and do not delay the user's main task with extensive research. Save the original SVG (prefer a compact mark without wordmark) or PNG, at most 256 KiB, to a temporary file INSIDE the project source root ON THE HOST returned by project_logo_status. Then call project_logo_install with that relative file path and the source page URL (or 'project asset'). It validates and preserves existing icons, writes .bb/icon.svg or .bb/icon.png, and refreshes Machine Tabs. Delete only your temporary download afterwards. Never commit or push this setup automatically. The icon is shared by the whole project and its threads. Respect any explicit user instruction to avoid changes.`;

export default function projectLogo(bb: BbPluginApi) {
  const locks = new Map<string, Promise<unknown>>();
  async function projectSource(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    if (project.kind !== "standard") throw new Error("Personal projects have no automatic logo");
    const sources = [...project.sources].sort((a,b) => Number(b.isDefault) - Number(a.isDefault));
    const source = sources.find(s => s.type === "local_path" && s.hostId && s.path);
    if (!source?.hostId || !source.path) throw new Error("No project source checkout available");
    return { projectId, projectName: project.name, hostId: source.hostId, rootPath: source.path.replace(/\/+$/, "") };
  }
  async function inspect(projectId: string) {
    const source = await projectSource(projectId);
    // Listing succeeds even for an empty directory; offline/permission errors
    // must never be treated as 'no icon'.
    const root = await bb.sdk.files.list({ hostId: source.hostId, path: source.rootPath, includeHidden: true });
    void root;
    for (const name of ICON_FILES) {
      try {
        const file = await bb.sdk.files.read({ hostId: source.hostId, rootPath: source.rootPath, path: `${source.rootPath}/${name}` });
        if (file.sizeBytes > 0 && file.sizeBytes <= MAX_BYTES) return { ...source, icon: name };
      } catch (error) {
        // Only absence is safe. Do not overwrite an inaccessible existing asset.
        const code = String((error as { code?: unknown }).code ?? "");
        const message = String((error as Error).message);
        if (!/ENOENT|not_found|not found|does not exist/i.test(`${code} ${message}`)) throw error;
      }
    }
    return { ...source, icon: null };
  }
  async function install(projectId: string, filePath: string, sourceUrl: string) {
    // Serialize two new threads choosing a logo for the same project.
    const previous = locks.get(projectId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const source = await inspect(projectId);
      if (source.icon) return { status: "existing", ...source };
      const relative = posix.normalize(filePath);
      if (posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../") || relative.includes("\\")) {
        throw new Error("Image path must be relative to the project source root");
      }
      const file = await bb.sdk.files.read({ hostId: source.hostId, rootPath: source.rootPath, path: `${source.rootPath}/${relative}` });
      if (!("content" in file) || typeof file.content !== "string") throw new Error("Image content unavailable");
      if (file.sizeBytes > MAX_BYTES) throw new Error("Image exceeds 256 KiB");
      const bytes = Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf8");
      const type = imageType(bytes);
      const icon = `.bb/icon.${type}`;
      await bb.sdk.files.write({ hostId: source.hostId, rootPath: source.rootPath,
        path: `${source.rootPath}/${icon}`, content: bytes.toString("base64"),
        contentEncoding: "base64", createParents: true, expectedSha256: null });
      await bb.storage.kv.set(`source:${projectId}`, { sourceUrl, icon, installedAt: Date.now() });
      try {
        await bb.sdk.plugins.callRpc({ pluginId: "machine-tabs", method: "project_icons", input: { refresh: true },
          outputSchema: z.object({ icons: z.record(z.string(), z.string()) }) });
      } catch (error) { bb.log.warn(`Logo saved; Machine Tabs refresh deferred: ${String(error)}`); }
      return { status: "installed", ...source, icon };
    });
    locks.set(projectId, work);
    try { return await work; } finally { if (locks.get(projectId) === work) locks.delete(projectId); }
  }
  bb.agents.registerTool({
    name: "project_logo_status", description: "Check the current project's shared icon and resolve its actual source host/root before automatic context-based logo selection.",
    parameters: z.object({}),
    async execute(_, ctx) {
      if (!ctx.projectId) return JSON.stringify({ status: "unavailable" });
      const result = await inspect(ctx.projectId);
      await bb.sdk.threads.updatePluginMetadata({ threadId: ctx.threadId, set: { checked: true } });
      return JSON.stringify({ status: result.icon ? "existing" : "missing", ...result });
    },
  });
  bb.agents.registerTool({
    name: "project_logo_install", description: "Install an authentic project logo from a file in its source checkout, preserving existing icons. PNG or passive SVG, max 256 KiB. Refreshes the project badge.",
    parameters: z.object({ filePath: z.string().min(1).max(1024), sourceUrl: z.string().min(1).max(2048) }),
    async execute(input, ctx) {
      if (!ctx.projectId) throw new Error("No project");
      return JSON.stringify(await install(ctx.projectId, input.filePath, input.sourceUrl));
    },
  });
  bb.agents.configure(ctx => ctx.project.kind !== "standard" || ctx.pluginMetadata.checked === true ? { tools: [], skills: [] } : {
    tools: ["project_logo_status", "project_logo_install"], skills: [], instructions,
  });
  bb.cli.register({ name: "project-logo", summary: "Inspect or install a project's shared logo",
    commands: [
      { name: "status", summary: "Check icon and source", usage: "status <project-id>" },
      { name: "install", summary: "Install without replacing an existing icon", usage: "install <project-id> <relative-image-path> <source-url>" },
    ],
    async run(argv) {
      const [command, projectId, filePath, sourceUrl] = argv;
      if (!projectId || (command !== "status" && command !== "install") ||
          (command === "install" && (!filePath || !sourceUrl))) {
        return { exitCode: 2, stderr: "Usage: bb project-logo status <project-id> | install <project-id> <relative-image-path> <source-url>\n" };
      }
      const result = command === "status" ? await inspect(projectId) : await install(projectId, filePath!, sourceUrl!);
      return { exitCode: 0, stdout: JSON.stringify(result, null, 2) + "\n" };
    },
  });
}
