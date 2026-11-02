import { describe, expect, it } from 'vitest';
import { contentRangeHeader, parseRange, retryAfterSeconds } from '../../worker/src/utils/range';

describe('Range header parsing', () => {
  it('returns none without a Range header', () => {
    expect(parseRange(null, 1000)).toEqual({ kind: 'none' });
    expect(parseRange(undefined, 1000)).toEqual({ kind: 'none' });
    expect(parseRange('', 1000)).toEqual({ kind: 'none' });
  });

  it('parses a closed range', () => {
    expect(parseRange('bytes=0-499', 1000)).toEqual({ kind: 'single', start: 0, end: 499, length: 500 });
    expect(parseRange('bytes=500-999', 1000)).toEqual({ kind: 'single', start: 500, end: 999, length: 500 });
  });

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=900-', 1000)).toEqual({ kind: 'single', start: 900, end: 999, length: 100 });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'single', start: 900, end: 999, length: 100 });
    // A suffix longer than the file returns the whole file.
    expect(parseRange('bytes=-5000', 1000)).toEqual({ kind: 'single', start: 0, end: 999, length: 1000 });
  });

  it('clamps an end beyond the file size (media players do this)', () => {
    expect(parseRange('bytes=0-99999', 1000)).toEqual({ kind: 'single', start: 0, end: 999, length: 1000 });
  });

  it('flags unsatisfiable ranges', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=2000-3000', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores multi-range requests so the full body is returned', () => {
    expect(parseRange('bytes=0-10,20-30', 1000)).toEqual({ kind: 'multiple' });
  });

  it('treats malformed headers as no range', () => {
    expect(parseRange('items=0-10', 1000)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=abc-def', 1000)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=-', 1000)).toEqual({ kind: 'none' });
  });

  it('is case insensitive', () => {
    expect(parseRange('BYTES=0-9', 1000)).toEqual({ kind: 'single', start: 0, end: 9, length: 10 });
  });

  it('formats Content-Range', () => {
    expect(contentRangeHeader(0, 499, 1000)).toBe('bytes 0-499/1000');
  });

  it('computes Retry-After seconds', () => {
    expect(retryAfterSeconds(10_000, 0)).toBe(10);
    expect(retryAfterSeconds(1, 5_000)).toBe(1);
  });
});
