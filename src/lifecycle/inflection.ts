/**
 * The English plural rules the vocabulary readers undo, declared once: the
 * lexicon check and lexicon coverage both merge a plural into its singular
 * through these, so the two never disagree on what a word is the plural of.
 */

/** The singulars a word may be the plural of, most likely first; none when it reads as no plural. */
export function singularForms(word: string): string[] {
  const out: string[] = [];
  if (word.endsWith("ies") && word.length > 4) out.push(word.slice(0, -3) + "y");
  if (/(?:ss|sh|ch|x|z)es$/.test(word)) out.push(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) out.push(word.slice(0, -1));
  return out;
}

/** A word's most likely singular, or the word itself when it reads as no plural. */
export function singular(word: string): string {
  return singularForms(word)[0] ?? word;
}
