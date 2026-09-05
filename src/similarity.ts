/**
 * Trimegisto - Similarity primitives
 *
 * Shared text-similarity helpers (word-shingle hashing + Jaccard).
 * Used by:
 *   - Loop Supervisor (intra-agent loop detection)
 *   - Loop Supervisor (cross-agent duplicate detection)
 *   - Pre-launch task deduplication
 *
 * Kept in one module so every consumer measures similarity the same way.
 */

/** Fast non-cryptographic string hash (FNV-1a 32-bit). */
export function quickHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalize text: lowercase, collapse whitespace, trim. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Word n-gram (shingle) hashes of normalized text.
 * Used to measure HOW SIMILAR two strings are instead of exact equality —
 * agents legitimately working on the same material share long common
 * prefixes but still make progress, so exact hashing produces false positives.
 */
export function shingleHashes(text: string, n = 8): number[] {
  const words = normalizeText(text).split(" ").filter(Boolean);
  if (words.length < n) {
    return words.length ? [quickHash(words.join(" "))] : [];
  }
  const out: number[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    out.push(quickHash(words.slice(i, i + n).join(" ")));
  }
  return out;
}

/** Jaccard similarity of two shingle sets (0 = disjoint, 1 = identical). */
export function jaccardSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const h of setA) {
    if (setB.has(h)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}
