/** Cyrillic to Latin, one letter at a time; the spellings people type are folded together below. */
const LETTERS: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * One Latin spelling for a name however it was written: "Маруся", "marusya"
 * and "marusia" all become "marusya". Lower-case input is expected.
 */
export function translit(text: string): string {
  let latin = "";
  for (const letter of text) latin += LETTERS[letter] ?? letter;
  return latin
    .replace(/shch/g, "sch")
    .replace(/kh/g, "h")
    .replace(/ts/g, "c")
    .replace(/i([au])/g, "y$1")
    .replace(/j/g, "y");
}

/**
 * Whether a title or a name answers any of the typed variants: as typed, or
 * with both sides brought to one Latin spelling, so "маруся" finds "marusya"
 * and "finansy" finds "Финансы". Single letters match only as typed.
 */
export function textMatches(text: string, needles: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  if (needles.some((needle) => haystack.includes(needle))) return true;
  const latin = translit(haystack);
  return needles.some((needle) => {
    const wanted = translit(needle);
    return wanted.length > 1 && latin.includes(wanted);
  });
}
