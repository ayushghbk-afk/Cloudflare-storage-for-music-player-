/**
 * Text normalisation used for matching and search.
 *
 * We store a normalised copy of every searchable field (`*_normalized`) so that
 * `LIKE`-based search is accent- and case-insensitive without relying on FTS5.
 * (D1 supports FTS5, but keeping the schema portable lets the same migrations be
 * validated locally against SQLite in CI.)
 */
const COMBINING_MARKS = /\p{M}+/gu;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

export function normalizeText(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_ALNUM, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Escape `%`, `_` and `\` for use inside a SQL `LIKE` pattern (ESCAPE '\'). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Build a `%term%` pattern that is safe to interpolate into a LIKE parameter. */
export function likePattern(input: string): string {
  return `%${escapeLike(normalizeText(input))}%`;
}

/**
 * Sanitise a user supplied filename into a safe object-key segment.
 * Keeps ASCII letters/digits/dot/dash/underscore; everything else becomes `-`.
 */
export function sanitizeFilename(name: string, fallback = 'upload.bin'): string {
  const base = name.split(/[\\/]/).pop() ?? fallback;
  const cleaned = base
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
