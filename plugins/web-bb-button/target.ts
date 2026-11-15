/** Opening a different browser requires an explicit public HTTP(S) address. */
export function webTarget(webUrl = "", appUrl: string | null = null): string {
  const target = webUrl.trim() || appUrl;
  if (!target) throw new Error("Configure the public BB address");
  const url = new URL(target);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) URL without credentials");
  }
  return url.href;
}
