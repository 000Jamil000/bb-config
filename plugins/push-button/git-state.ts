// Porcelain v2 reports the actual tracking branch, including non-origin remotes.
export function parseGitState(output: string) {
  const lines = output.split('\n');
  if (lines.some(line => /^(?:1 |2 |u |\? )/.test(line))) {
    return { state: 'ready' as const, message: 'Есть изменения — отправить «пуш» в тред' };
  }
  const aheadBehind = lines.find(line => line.startsWith('# branch.ab '));
  const ahead = Number(aheadBehind?.match(/\+(\d+)/)?.[1] ?? 0);
  if (ahead > 0) return { state: 'ready' as const, message: `Коммитов для отправки: ${ahead} — отправить «пуш» в тред` };
  const head = lines.find(line => line.startsWith('# branch.oid '));
  const branch = lines.find(line => line.startsWith('# branch.head '));
  if (!aheadBehind && head && !head.endsWith('(initial)') && branch && !branch.endsWith('(detached)')) {
    return { state: 'ready' as const, message: 'Ветка ещё не опубликована — отправить «пуш» в тред' };
  }
  return { state: 'clean' as const, message: 'Нечего отправлять: изменений и новых коммитов нет' };
}
