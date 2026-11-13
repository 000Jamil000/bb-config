import { spawn } from 'node:child_process';
import type { Check, StoredProxy } from './contract';
// Credentials are supplied on stdin, never process arguments or environment.
export function curlConfig(proxy: StoredProxy | null): string {
  const quote = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n') + '"';
  if (!proxy) return 'proxy = ""\nnoproxy = "*"\n';
  return `proxy = ${quote(`${proxy.protocol}://${proxy.host}:${proxy.port}`)}\nnoproxy = ""\nproxy-user = ${quote(`${proxy.username}:${proxy.password}`)}\n`;
}
function request(url: string, proxy: StoredProxy | null, signal: AbortSignal): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['--config', '-', '--silent', '--connect-timeout', '8', '--max-time', '15', '--max-filesize', '65536', '--write-out', '\n%{http_code}', url], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let output = ''; let excessive = false;
    child.stdout.on('data', (chunk: Buffer) => { if (output.length + chunk.length > 70000) { excessive = true; child.kill(); } else output += chunk.toString(); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new Error('Не удалось запустить проверку на этой машине')));
    child.once('close', code => {
      if (code !== 0 || excessive) return reject(new Error('Прокси недоступен, отклонил авторизацию или истёк таймаут'));
      const idx = output.lastIndexOf('\n'); resolve({ code: Number(output.slice(idx + 1)), body: output.slice(0, idx) });
    });
    child.stdin.end(curlConfig(proxy));
  });
}
export async function checkConnection(proxy: StoredProxy | null, signal: AbortSignal): Promise<Check> {
  const start = Date.now();
  const [egress, openai] = await Promise.allSettled([
    request('https://ipinfo.io/json', proxy, signal), request('https://chatgpt.com/backend-api/codex/models', proxy, signal),
  ]);
  let ip: string | null = null, country: string | null = null, city: string | null = null;
  if (egress.status === 'fulfilled' && egress.value.code === 200) {
    try { const json = JSON.parse(egress.value.body); ip = typeof json.ip === 'string' ? json.ip : null; country = typeof json.country === 'string' ? json.country : null; city = typeof json.city === 'string' ? json.city : null; } catch {}
  }
  const openaiStatus = openai.status === 'fulfilled' ? openai.value.code : null;
  const ok = !!ip && (openaiStatus === 200 || openaiStatus === 401);
  return { ok, ip, country, city, openaiStatus, message: ok ? 'Маршрут работает; OpenAI доступен (без передачи токена аккаунта)' : !ip ? 'Не удалось проверить внешний IP' : `OpenAI недоступен${openaiStatus ? `: HTTP ${openaiStatus}` : ': ошибка соединения'}`, checkedAt: new Date().toISOString(), latencyMs: Date.now() - start };
}

export async function probeConnection(proxy: StoredProxy | null, previous: Check, signal: AbortSignal): Promise<Check> {
  const start = Date.now();
  let openaiStatus: number | null = null;
  try { openaiStatus = (await request('https://chatgpt.com/backend-api/codex/models', proxy, signal)).code; } catch {}
  const ok = openaiStatus === 200 || openaiStatus === 401;
  return { ...previous, ok, openaiStatus, checkedAt: new Date().toISOString(), latencyMs: Date.now() - start, message: ok ? 'Проверка подключения пройдена' : `Подключение недоступно${openaiStatus ? `: HTTP ${openaiStatus}` : ': ошибка соединения'}` };
}
