import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { GridIcon, Icon } from './icons';
import { Input } from '@/components/ui/input';
import type { Catalog, ProjectView, rpcContract } from './contract';
import { search, type AutoField, type Level, type Status } from './core';
import './catalog.css';

type Source = ProjectView['sources'][number];
const NO_CATEGORY = 'Без категории';

const LEVEL: Record<Level, { icon: string; text: string; dot: string }> = {
  ok: { icon: 'CircleCheck', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  info: { icon: 'CircleCheck', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
  attention: { icon: 'TriangleAlert', text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  risk: { icon: 'OctagonAlert', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' },
  unknown: { icon: 'CircleHelp', text: 'text-muted-foreground', dot: 'bg-slate-400' },
};
const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';
const selectClass = 'h-9 min-w-0 cursor-pointer rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring';

function hue(text: string) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) % 360;
  return value;
}
function ago(time: number | null) {
  if (!time) return 'ещё не проверялось';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
}
const isMac = (name: string) => /mac|book|laptop/i.test(name);
const shortHost = (name: string) => /macbook/i.test(name) ? 'Mac' : name.split(/\s[—-]\s/)[0]!.replace(/\s*\(\d+\)$/, '');

function sourceState(source: Source): { level: Level; text: string } {
  const scan = source.scan;
  if (!scan) return { level: 'unknown', text: source.connected ? 'ещё не проверено' : 'не проверено, машина офлайн' };
  if (scan.kind === 'error') return { level: 'unknown', text: `не удалось проверить: ${scan.error ?? 'ошибка'}` };
  if (scan.kind === 'missing') return { level: 'attention', text: 'папка не найдена' };
  if (scan.kind === 'plain' && scan.plain) return { level: 'ok', text: `без git · ${scan.plain.files}${scan.plain.truncated ? '+' : ''} файлов` };
  const git = scan.git!;
  const parts = [git.branch ?? 'detached', git.head ? git.head.slice(0, 7) : 'нет коммитов'];
  const local = git.dirty + git.untracked;
  if (local) parts.push(`${local} не закоммичено`);
  if (git.ahead) parts.push(`${git.ahead} не отправлено`);
  if (git.behind) parts.push(`отстаёт на ${git.behind}`);
  if (!git.hasUpstream) parts.push('нет remote-ветки');
  return { level: local || git.ahead ? 'attention' : 'ok', text: parts.join(' · ') };
}

function Avatar({ project, size = 'size-9' }: { project: ProjectView; size?: string }) {
  if (project.icon) return <img src={project.icon} alt="" className={`${size} shrink-0 rounded-lg bg-muted/60 object-contain p-1.5`}/>;
  const h = hue(project.name);
  return <span aria-hidden="true" className={`${size} flex shrink-0 items-center justify-center rounded-lg text-sm font-semibold`}
    style={{ background: `hsl(${h} 60% 50% / 0.16)`, color: `hsl(${h} 55% 52%)` }}>{project.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '·'}</span>;
}
function VerdictBadge({ project }: { project: ProjectView }) {
  const style = LEVEL[project.verdict.level];
  return <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium ${style.text}`} title={project.verdict.details.join('\n') || project.verdict.label}>
    <Icon name={style.icon} fallback="Circle" className="size-3.5 shrink-0" aria-hidden="true"/>{project.verdict.label}
  </span>;
}
function Row({ project, active, onOpen, onThread }: { project: ProjectView; active: boolean; onOpen: () => void; onThread: () => void }) {
  const entry = project.entry;
  const quiet = project.verdict.level === 'ok' || project.verdict.level === 'info';
  const hosts = [...new Set(project.sources.map(source => shortHost(source.hostName)))];
  return <li className={`catalog-row group relative flex items-center gap-3 rounded-lg px-2.5 py-2 ${active ? 'bg-muted' : ''} ${entry.status === 'archive' ? 'opacity-60' : ''}`}>
    <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined} className="absolute inset-0 cursor-pointer rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Открыть «${project.name}»`}/>
    <Avatar project={project} size="size-7"/>
    <div className="pointer-events-none relative min-w-0 flex-1">
      <p className="flex items-baseline gap-2">
        <span className="truncate text-sm font-medium" title={project.name}>{project.name}</span>
        {!quiet && <VerdictBadge project={project}/>}
      </p>
      <p className={`truncate text-[13px] leading-5 ${entry.summary ? 'text-muted-foreground' : 'italic text-muted-foreground/60'}`}>{entry.summary || 'Описания пока нет'}</p>
    </div>
    <span className="pointer-events-none relative hidden w-20 shrink-0 truncate text-right text-xs text-muted-foreground sm:block" title={project.sources.map(source => `${source.hostName}: ${source.path}`).join('\n')}>{hosts.join(' · ') || '—'}</span>
    <Button size="icon" variant="ghost" className="catalog-row-action relative size-7 shrink-0 text-muted-foreground" aria-label={`Новый тред в «${project.name}»`} onClick={onThread}>
      <Icon name="SquarePen" className="size-3.5" aria-hidden="true"/>
    </Button>
  </li>;
}

type Form = { summary: string; notes: string; category: string; tags: string; aliases: string; links: string; status: Status; independent: boolean; localPaths: string };
const toForm = (project: ProjectView): Form => ({
  summary: project.entry.summary, notes: project.entry.notes, category: project.entry.category,
  tags: project.entry.tags.join(', '), aliases: project.entry.aliases.join(', '),
  links: project.entry.links.map(link => `${link.label} = ${link.url}`).join('\n'), status: project.entry.status,
  independent: project.entry.independent, localPaths: project.entry.localPaths.join(', '),
});
const list = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean);
const parseLinks = (text: string) => text.split('\n').map(row => row.trim()).filter(Boolean).map(row => {
  const at = row.indexOf('=');
  return at > 0 && !/^https?:/i.test(row.slice(0, at).trim()) ? { label: row.slice(0, at).trim(), url: row.slice(at + 1).trim() } : { label: '', url: row };
});

function Field({ label, hint, locked, onUnlock, children }: { label: string; hint?: ReactNode; locked?: boolean; onUnlock?: () => void; children: ReactNode }) {
  return <label className="block space-y-1.5">
    <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      {locked && onUnlock && <button type="button" className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground" title="Поле закреплено за вами. Нажмите, чтобы ИИ снова мог его обновлять."
        onClick={event => { event.preventDefault(); onUnlock(); }}><Icon name="Lock" className="size-3" aria-hidden="true"/>ваш текст · открепить</button>}
    </span>
    {children}
    {hint && <span className="block text-xs text-muted-foreground/80">{hint}</span>}
  </label>;
}
const Section = ({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) => <section className="space-y-2">
  <div className="flex items-center justify-between gap-2"><h3 className="text-xs text-muted-foreground">{title}</h3>{action}</div>
  {children}
</section>;

function Detail({ project, categories, scanning, onClose, onSaved }: { project: ProjectView; categories: string[]; scanning: boolean; onClose: () => void; onSaved: (next: ProjectView) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(() => toForm(project));
  const [busy, setBusy] = useState<string | null>(null);
  const entry = project.entry;
  const locked = (field: AutoField) => entry.locked.includes(field);
  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try { await work(); } catch (error) { toast.error(String((error as Error).message ?? error)); } finally { setBusy(null); }
  };
  const save = () => run('save', async () => {
    const next = await rpc.call('save', { projectId: project.id, patch: { summary: form.summary, notes: form.notes, category: form.category, tags: list(form.tags), aliases: list(form.aliases), links: parseLinks(form.links), status: form.status, independent: form.independent, localPaths: list(form.localPaths) } });
    onSaved(next); setForm(toForm(next)); setEditing(false); toast.success('Сохранено');
  });
  const release = (field: AutoField) => run(`unlock:${field}`, async () => { onSaved(await rpc.call('unlock', { projectId: project.id, fields: [field] })); });
  const copy = (text: string, what: string) => { void navigator.clipboard?.writeText(text).then(() => toast.success(`${what} скопирован`)); };
  const alarming = project.verdict.level === 'risk' || project.verdict.level === 'attention';
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !editing) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  return <aside aria-label={`Проект ${project.name}`} className="catalog-detail absolute inset-0 z-20 flex flex-col bg-background lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:border-l lg:border-border">
    <header className="flex items-center gap-3 px-5 pb-3 pt-5">
      <Avatar project={project} size="size-9"/>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold">{project.name}</h2>
        <p className="truncate text-xs text-muted-foreground">{entry.category || NO_CATEGORY}{entry.status === 'paused' ? ' · на паузе' : entry.status === 'archive' ? ' · архив' : ''}</p>
      </div>
      <Button size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground" aria-label="Закрыть" onClick={onClose}><Icon name="X" className="size-4" aria-hidden="true"/></Button>
    </header>
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 pb-6">
      {!editing && <>
        <div className="flex gap-2">
          <Button size="sm" className="gap-1.5" onClick={() => navigate.toProject(project.id)}><Icon name="SquarePen" className="size-3.5" aria-hidden="true"/>Новый тред</Button>
          <Button size="sm" variant="outline" onClick={() => { setForm(toForm(project)); setEditing(true); }}>Изменить</Button>
        </div>
        <div className="space-y-3">
          <p className={`text-sm leading-relaxed ${entry.summary ? '' : 'italic text-muted-foreground'}`}>{entry.summary || 'Описания пока нет. Его напишет агент в первом треде проекта, или добавьте сами.'}</p>
          {entry.notes && <p className="whitespace-pre-wrap border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">{entry.notes}</p>}
          {entry.links.length > 0 && <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{entry.links.map(link =>
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="inline-flex cursor-pointer items-center gap-1 underline underline-offset-2 hover:text-foreground"><Icon name="ExternalLink" className="size-3" aria-hidden="true"/>{link.label}</a>)}</p>}
        </div>
        <Section title="На машинах" action={<button type="button" disabled={scanning || busy !== null} className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-60"
          onClick={() => void run('refresh', async () => { await rpc.call('refresh', { projectId: project.id }); })}>
          <Icon name="RefreshCw" className={`size-3 ${scanning ? 'catalog-spin' : ''}`} aria-hidden="true"/>{scanning ? 'Проверяю…' : 'Проверить'}</button>}>
          {alarming && <p className={`flex items-start gap-1.5 text-sm ${LEVEL[project.verdict.level].text}`}><Icon name={LEVEL[project.verdict.level].icon} className="mt-0.5 size-4 shrink-0" aria-hidden="true"/>
            <span>{project.verdict.level === 'risk' ? 'Копии расходятся' : 'Есть несохранённая работа'}</span></p>}
          {!project.sources.length && <p className="text-sm text-muted-foreground">У проекта нет папки ни на одной машине.</p>}
          <ul className="space-y-3">{project.sources.map(source => {
            const state = sourceState(source);
            return <li key={source.id} className="group/src flex items-start gap-2.5">
              <Icon name={isMac(source.hostName) ? 'Laptop' : 'Server'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true"/>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="flex items-center gap-1.5 text-sm"><span className="font-medium">{shortHost(source.hostName)}</span>
                  <span className={`size-1.5 shrink-0 rounded-full ${LEVEL[state.level].dot}`} aria-hidden="true"/>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{state.text}{!source.connected ? ' · офлайн' : ''}</span></p>
                <button type="button" className="block max-w-full cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground/80 hover:text-foreground" title="Скопировать путь" onClick={() => copy(source.path, 'Путь')}>{source.path}</button>
                {source.scan?.parts?.map(part => { const local = part.git.dirty + part.git.untracked; return <p key={part.path} className="truncate text-xs text-muted-foreground" title={part.path}>
                  <span className="text-foreground/80">{part.path.split('/').pop()}</span> — свой git{local ? ` · ${local} не закоммичено` : ''}{part.git.ahead ? ` · ${part.git.ahead} не отправлено` : ''}</p>; })}
              </div>
            </li>;
          })}</ul>
          {alarming && <ul className="space-y-1 text-xs text-muted-foreground">{project.verdict.details.map(detail => <li key={detail}>{detail}</li>)}</ul>}
          {project.diff && !entry.independent && project.diff.sample.length > 0 && <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Отличающиеся файлы: {project.diff.changed + project.diff.onlyA + project.diff.onlyB}</summary>
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">{project.diff.sample.map(file => <li key={`${file.kind}:${file.path}`}>
              <span className="break-all font-mono">{file.path}</span>
              <span className="text-muted-foreground"> — {file.kind === 'changed' ? (file.newer ? `новее на ${shortHost(file.newer === 'a' ? project.diff!.a : project.diff!.b)}` : 'изменён') : `только на ${shortHost(file.kind === 'onlyA' ? project.diff!.a : project.diff!.b)}`}</span>
            </li>)}</ul>
          </details>}
          {entry.localPaths.length > 0 && <p className="text-xs text-muted-foreground">Не сравниваются (свои на каждой машине): {entry.localPaths.join(', ')}</p>}
          {entry.independent && <p className="text-xs text-muted-foreground">Копии помечены как разные и не сравниваются.</p>}
        </Section>
        {(entry.aliases.length > 0 || entry.tags.length > 0) && <dl className="space-y-1.5 text-xs text-muted-foreground">
          {entry.aliases.length > 0 && <div className="flex gap-2"><dt className="w-20 shrink-0">Называю</dt><dd className="min-w-0 text-foreground/80">{entry.aliases.join(', ')}</dd></div>}
          {entry.tags.length > 0 && <div className="flex gap-2"><dt className="w-20 shrink-0">Теги</dt><dd className="min-w-0 text-foreground/80">{entry.tags.join(', ')}</dd></div>}
        </dl>}
      </>}
      {editing && <div className="space-y-4">
        <Field label="Описание" locked={locked('summary')} onUnlock={() => void release('summary')}>
          <textarea autoFocus className={fieldClass} rows={4} maxLength={600} value={form.summary} placeholder="Что это за проект и зачем он" onChange={event => setForm({ ...form, summary: event.target.value })}/>
        </Field>
        <Field label="Мои заметки" hint="ИИ этот текст не меняет.">
          <textarea className={fieldClass} rows={3} maxLength={4000} value={form.notes} placeholder="Что важно помнить" onChange={event => setForm({ ...form, notes: event.target.value })}/>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Категория" locked={locked('category')} onUnlock={() => void release('category')}>
            <Input list="catalog-categories" maxLength={40} value={form.category} onChange={event => setForm({ ...form, category: event.target.value })}/>
            <datalist id="catalog-categories">{categories.map(name => <option key={name} value={name}/>)}</datalist>
          </Field>
          <Field label="Статус">
            <select className={`${selectClass} w-full`} value={form.status} onChange={event => setForm({ ...form, status: event.target.value as Status })}>
              <option value="active">Активный</option><option value="paused">На паузе</option><option value="archive">Архив</option>
            </select>
          </Field>
        </div>
        <Field label="Как ещё называю" locked={locked('aliases')} onUnlock={() => void release('aliases')} hint="Через запятую. По этим словам проект находят поиск и агенты.">
          <Input value={form.aliases} onChange={event => setForm({ ...form, aliases: event.target.value })}/>
        </Field>
        <Field label="Теги" locked={locked('tags')} onUnlock={() => void release('tags')}>
          <Input value={form.tags} onChange={event => setForm({ ...form, tags: event.target.value })}/>
        </Field>
        <Field label="Ссылки" locked={locked('links')} onUnlock={() => void release('links')} hint="По одной в строке: Название = https://…">
          <textarea className={`${fieldClass} font-mono text-xs`} rows={2} value={form.links} onChange={event => setForm({ ...form, links: event.target.value })}/>
        </Field>
        {project.sources.length > 1 && <div className="space-y-3 border-t border-border pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 cursor-pointer" checked={form.independent} onChange={event => setForm({ ...form, independent: event.target.checked })}/>
            Копии на машинах разные — не сравнивать
          </label>
          {!form.independent && <Field label="Папки, которые на каждой машине свои" hint="Через запятую, от корня проекта. В сравнении не участвуют.">
            <Input value={form.localPaths} onChange={event => setForm({ ...form, localPaths: event.target.value })}/>
          </Field>}
        </div>}
        <button type="button" disabled={busy !== null} className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          onClick={() => void run('describe', async () => { const { threadId } = await rpc.call('describe_with_agent', { projectId: project.id }); toast.success('Агент описывает проект'); navigate.toThread(threadId); })}>
          <Icon name="Sparkles" className="size-3.5" aria-hidden="true"/>{busy === 'describe' ? 'Запускаю…' : 'Поручить описание агенту (отдельный тред)'}
        </button>
        <button type="button" className="block cursor-pointer font-mono text-[11px] text-muted-foreground/70 hover:text-foreground" title="Скопировать ID проекта" onClick={() => copy(project.id, 'ID')}>{project.id}</button>
      </div>}
    </div>
    {editing && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Отмена</Button>
      <Button size="sm" disabled={busy !== null || JSON.stringify(form) === JSON.stringify(toForm(project))} onClick={() => void save()}>{busy === 'save' ? 'Сохраняю…' : 'Сохранить'}</Button>
    </footer>}
  </aside>;
}

let cached: Catalog | null = null;
type View = { kind: 'all' } | { kind: 'category'; name: string } | { kind: 'focus'; name: 'attention' | 'risk' | 'undescribed' | 'archive' } | { kind: 'machine'; id: string };
const viewKey = (view: View) => view.kind === 'all' ? 'all' : `${view.kind}:${'name' in view ? view.name : view.id}`;

function NavItem({ label, count, active, tone, onClick }: { label: string; count?: number; active: boolean; tone?: string; onClick: () => void }) {
  return <button type="button" aria-current={active ? 'true' : undefined} onClick={onClick}
    className={`catalog-nav flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 text-left text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
    <span className="truncate">{label}</span>{count !== undefined && <span className={`shrink-0 text-xs tabular-nums ${tone ?? 'opacity-60'}`}>{count}</span>}
  </button>;
}

function CatalogPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<Catalog | null>(cached);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>({ kind: 'all' });
  const searchRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try { const next = await rpc.call('catalog'); cached = next; setData(next); setError(''); }
    catch (reason) { setError(String((reason as Error).message ?? reason)); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  useRealtime('changed', () => { void load(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !(target && /input|textarea|select/i.test(target.tagName)) && !target?.isContentEditable) { event.preventDefault(); searchRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const projects = data?.projects ?? [];
  const openId = subPath ? decodeURIComponent(subPath.split('/')[0]!) : '';
  const opened = projects.find(project => project.id === openId) ?? null;
  const open = useCallback((id: string | null) => navigate.toPluginPanel('projects', id ? { subPath: id, replace: Boolean(openId) } : { replace: true }), [navigate, openId]);
  const close = useCallback(() => open(null), [open]);
  const live = useMemo(() => projects.filter(project => project.entry.status !== 'archive'), [projects]);
  const count = {
    attention: live.filter(project => project.verdict.level === 'attention').length,
    risk: live.filter(project => project.verdict.level === 'risk').length,
    undescribed: live.filter(project => !project.entry.summary).length,
    archive: projects.length - live.length,
  };
  const categories = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of live) map.set(project.entry.category || NO_CATEGORY, (map.get(project.entry.category || NO_CATEGORY) ?? 0) + 1);
    return [...map].sort((a, b) => Number(a[0] === NO_CATEGORY) - Number(b[0] === NO_CATEGORY) || a[0].localeCompare(b[0]));
  }, [live]);
  const visible = useMemo(() => {
    let items = view.kind === 'focus' && view.name === 'archive' ? projects.filter(project => project.entry.status === 'archive') : live;
    if (view.kind === 'focus' && view.name === 'attention') items = items.filter(project => project.verdict.level === 'attention');
    if (view.kind === 'focus' && view.name === 'risk') items = items.filter(project => project.verdict.level === 'risk');
    if (view.kind === 'focus' && view.name === 'undescribed') items = items.filter(project => !project.entry.summary);
    if (view.kind === 'machine') items = items.filter(project => project.sources.some(source => source.hostId === view.id));
    if (view.kind === 'category') items = items.filter(project => (project.entry.category || NO_CATEGORY) === view.name);
    if (query.trim()) {
      const docs = items.map(project => ({ id: project.id, name: project.name, aliases: project.entry.aliases, category: project.entry.category, tags: project.entry.tags, summary: project.entry.summary, notes: project.entry.notes, paths: project.sources.map(source => source.path), project }));
      return search(docs, query).map(hit => hit.doc.project);
    }
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, live, view, query]);
  const grouped = !query.trim() && view.kind !== 'category';
  const groups = useMemo(() => {
    if (!grouped) return [{ name: '', items: visible }];
    const map = new Map<string, ProjectView[]>();
    for (const project of visible) { const key = project.entry.category || NO_CATEGORY; map.set(key, [...(map.get(key) ?? []), project]); }
    return [...map].sort((a, b) => Number(a[0] === NO_CATEGORY) - Number(b[0] === NO_CATEGORY) || a[0].localeCompare(b[0])).map(([name, items]) => ({ name, items }));
  }, [visible, grouped]);
  const refresh = async () => { try { await rpc.call('refresh', { projectId: null }); } catch (reason) { toast.error(String((reason as Error).message ?? reason)); } };
  const patch = (next: ProjectView) => setData(old => { const merged = old ? { ...old, projects: old.projects.map(project => project.id === next.id ? next : project) } : old; cached = merged; return merged; });
  const is = (other: View) => viewKey(view) === viewKey(other);
  const title = view.kind === 'all' ? 'Все проекты' : view.kind === 'category' ? view.name : view.kind === 'machine' ? `На ${shortHost(data?.hosts.find(host => host.id === view.id)?.name ?? '')}`
    : view.name === 'attention' ? 'Несохранённая работа' : view.name === 'risk' ? 'Копии расходятся' : view.name === 'undescribed' ? 'Без описания' : 'Архив';
  const focusItems: { name: 'risk' | 'attention' | 'undescribed' | 'archive'; label: string; count: number; tone?: string }[] = [
    { name: 'risk' as const, label: 'Копии расходятся', count: count.risk, tone: 'text-red-600 dark:text-red-400' },
    { name: 'attention' as const, label: 'Несохранённая работа', count: count.attention, tone: 'text-amber-600 dark:text-amber-400' },
    { name: 'undescribed' as const, label: 'Без описания', count: count.undescribed },
    { name: 'archive' as const, label: 'Архив', count: count.archive },
  ].filter(item => item.count > 0);
  const options: { key: string; label: string; view: View }[] = [
    { key: 'all', label: `Все проекты · ${live.length}`, view: { kind: 'all' } },
    ...categories.map(([name, total]) => ({ key: `category:${name}`, label: `${name} · ${total}`, view: { kind: 'category', name } as View })),
    ...focusItems.map(item => ({ key: `focus:${item.name}`, label: `${item.label} · ${item.count}`, view: { kind: 'focus', name: item.name } as View })),
    ...(data?.hosts ?? []).map(host => ({ key: `machine:${host.id}`, label: `На ${shortHost(host.name)}`, view: { kind: 'machine', id: host.id } as View })),
  ];

  return <div className="relative flex h-full min-h-0">
    <nav aria-label="Разделы каталога" className="hidden w-56 shrink-0 space-y-5 overflow-y-auto border-r border-border px-3 py-5 md:block">
      <div className="space-y-0.5">
        <NavItem label="Все проекты" count={live.length} active={is({ kind: 'all' })} onClick={() => setView({ kind: 'all' })}/>
        {categories.map(([name, total]) => <NavItem key={name} label={name} count={total} active={is({ kind: 'category', name })} onClick={() => setView({ kind: 'category', name })}/>)}
      </div>
      {focusItems.length > 0 && <div className="space-y-0.5">
        <p className="px-2.5 pb-1 text-[11px] text-muted-foreground/70">Состояние</p>
        {focusItems.map(item => <NavItem key={item.name} label={item.label} count={item.count} tone={item.tone} active={is({ kind: 'focus', name: item.name })} onClick={() => setView({ kind: 'focus', name: item.name })}/>)}
      </div>}
      {(data?.hosts.length ?? 0) > 1 && <div className="space-y-0.5">
        <p className="px-2.5 pb-1 text-[11px] text-muted-foreground/70">Машины</p>
        {data?.hosts.map(host => <NavItem key={host.id} label={shortHost(host.name)} count={live.filter(project => project.sources.some(source => source.hostId === host.id)).length} active={is({ kind: 'machine', id: host.id })} onClick={() => setView({ kind: 'machine', id: host.id })}/>)}
      </div>}
    </nav>
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
        <header className="flex items-center justify-between gap-3">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          <button type="button" disabled={!data || data.scanning} onClick={() => void refresh()} title="Проверить копии на машинах"
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-60">
            <Icon name="RefreshCw" className={`size-3.5 ${data?.scanning ? 'catalog-spin' : ''}`} aria-hidden="true"/>{data?.scanning ? 'Проверяю машины…' : `Проверено ${ago(data?.scannedAt ?? null)}`}
          </button>
        </header>
        {error && <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
            <Input ref={searchRef} type="search" aria-label="Поиск по проектам" className="pl-9" value={query} placeholder="Найти проект" onChange={event => setQuery(event.target.value)}/>
          </div>
          <select aria-label="Раздел" className={`${selectClass} max-w-[45%] md:hidden`} value={viewKey(view)} onChange={event => setView(options.find(option => option.key === event.target.value)?.view ?? { kind: 'all' })}>
            {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </div>
        <div className="mt-4 space-y-6">
          {!data && !error && <ul className="space-y-1">{Array.from({ length: 10 }, (_, i) => <li key={i} className="catalog-skeleton h-[52px] rounded-lg bg-muted/40"/>)}</ul>}
          {data && !visible.length && <div className="px-2 py-16 text-center">
            <p className="text-sm">{query.trim() ? `По запросу «${query.trim()}» ничего не нашлось` : 'В этом разделе пусто'}</p>
            <Button size="sm" variant="outline" className="mt-4" onClick={() => { setQuery(''); setView({ kind: 'all' }); }}>Показать все проекты</Button>
          </div>}
          {groups.map(group => group.items.length > 0 && <section key={group.name || 'flat'}>
            {group.name && <h2 className="px-2.5 pb-1 text-xs text-muted-foreground">{group.name}</h2>}
            <ul>{group.items.map(project => <Row key={project.id} project={project} active={project.id === openId} onOpen={() => open(project.id)} onThread={() => navigate.toProject(project.id)}/>)}</ul>
          </section>)}
        </div>
      </div>
    </div>
    {opened && <Detail key={opened.id} project={opened} categories={categories.map(([name]) => name).filter(name => name !== NO_CATEGORY)} scanning={data?.scanning ?? false} onClose={close} onSaved={patch}/>}
  </div>;
}

export default definePluginApp(app => {
  app.experimental_icons.register({ name: 'project-catalog/grid', component: GridIcon });
  app.slots.navPanel({ id: 'projects', title: 'Проекты', icon: 'project-catalog/grid', path: 'projects', component: CatalogPage });
});
