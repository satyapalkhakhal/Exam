// wordCount.ts
// One word-count rule for both sides, so the live counter the candidate sees and
// the word_count the server stores can never disagree. Splits on Unicode
// whitespace (so Devanagari and other scripts count correctly) and ignores empties.

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((token) => token.length > 0).length;
}
