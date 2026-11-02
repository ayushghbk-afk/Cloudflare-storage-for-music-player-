/**
 * HTTP Range parsing (RFC 9110 §14).
 *
 * Only single ranges are honoured; multi-range requests are answered with the
 * full representation (a server MAY ignore Range), which every media player
 * (browser `<audio>`, Android Media3/ExoPlayer) handles correctly.
 */
export type ParsedRange =
  | { kind: 'none' }
  | { kind: 'single'; start: number; end: number; length: number }
  | { kind: 'multiple' }
  | { kind: 'unsatisfiable' };

export function parseRange(header: string | null | undefined, size: number): ParsedRange {
  if (!header) return { kind: 'none' };
  const trimmed = header.trim();
  const match = /^bytes=(.+)$/i.exec(trimmed);
  if (!match) return { kind: 'none' };

  const spec = match[1]!.trim();
  if (spec.includes(',')) return { kind: 'multiple' };

  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: 'none' };
  const [, rawStart, rawEnd] = parts;

  if (rawStart === '' && rawEnd === '') return { kind: 'none' };

  if (size === 0) return { kind: 'unsatisfiable' };

  // suffix range: `bytes=-500` → last 500 bytes
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' };
    const length = Math.min(suffixLength, size);
    return { kind: 'single', start: size - length, end: size - 1, length };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable' };

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return { kind: 'unsatisfiable' };

  return { kind: 'single', start, end, length: end - start + 1 };
}

export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/** Formats `Retry-After` seconds from a millisecond timestamp. */
export function retryAfterSeconds(untilMs: number, nowMs = Date.now()): number {
  return Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
}
