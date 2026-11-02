import { MAX_ARTWORK_BYTES, type AudioTags, type ExtractedArtwork } from './types';

/**
 * ISO base media file format (M4A/MP4/AAC-in-MP4) parser.
 *
 * The `moov` atom may live at the end of the file (`moov` after `mdat`, common for
 * streamed/optimised files), so the caller supplies both a leading and a trailing
 * window and this parser searches whichever contains `moov`.
 */
export interface Mp4Result {
  tags: AudioTags;
  artwork?: ExtractedArtwork;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  bitrateKbps?: number;
  warnings: string[];
}

interface Box {
  type: string;
  /** Absolute offset of the box within its buffer. */
  start: number;
  /** Absolute offset of the first content byte. */
  contentStart: number;
  /** Absolute end offset (exclusive). */
  end: number;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readUint64(bytes: Uint8Array, offset: number): number {
  const high = readUint32(bytes, offset);
  const low = readUint32(bytes, offset + 4);
  return high * 2 ** 32 + low;
}

function boxType(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}

function* iterateBoxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32(bytes, offset);
    const type = boxType(bytes, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = readUint64(bytes, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      // Malformed or truncated: stop rather than misparse.
      return;
    }
    yield { type, start: offset, contentStart: offset + headerSize, end: offset + size };
    offset += size;
  }
}

function findChild(bytes: Uint8Array, parent: Box, type: string): Box | null {
  for (const child of iterateBoxes(bytes, parent.contentStart, parent.end)) {
    if (child.type === type) return child;
  }
  return null;
}

/** `meta` is a FullBox: 4 bytes of version/flags precede its children. */
function metaChildrenStart(bytes: Uint8Array, meta: Box): number {
  return meta.contentStart + 4 <= meta.end ? meta.contentStart + 4 : meta.contentStart;
}

function locateMoov(head: Uint8Array, tail: Uint8Array): { bytes: Uint8Array; box: Box } | null {
  for (const box of iterateBoxes(head, 0, head.length)) {
    if (box.type === 'moov') return { bytes: head, box };
  }
  // Search the tail window for a plausible moov header.
  for (let i = 0; i + 4 <= tail.length; i += 1) {
    if (tail[i] === 0x6d && tail[i + 1] === 0x6f && tail[i + 2] === 0x6f && tail[i + 3] === 0x76) {
      for (const headerOffset of [i - 4, i - 12]) {
        if (headerOffset < 0) continue;
        const size = readUint32(tail, headerOffset);
        const headerSize = size === 1 ? 16 : 8;
        if (size >= headerSize && headerOffset + size <= tail.length) {
          return {
            bytes: tail,
            box: { type: 'moov', start: headerOffset, contentStart: headerOffset + headerSize, end: headerOffset + size },
          };
        }
      }
    }
  }
  return null;
}

function decodeText(bytes: Uint8Array): string {
  // eslint-disable-next-line no-control-regex -- atoms are NUL padded
  return new TextDecoder('utf-8').decode(bytes).replace(/\u0000+$/g, '').trim();
}

const TEXT_ATOMS: Record<string, keyof AudioTags> = {
  '\u00a9nam': 'title',
  '\u00a9ART': 'artist',
  'aART': 'albumArtist',
  '\u00a9alb': 'album',
  '\u00a9gen': 'genre',
  '\u00a9cmt': 'comment',
  '\u00a9day': 'year',
};

export function parseMp4(head: Uint8Array, tail: Uint8Array): Mp4Result | null {
  if (head.length < 12 || boxType(head, 4) !== 'ftyp') return null;

  const warnings: string[] = [];
  const tags: AudioTags = {};
  let artwork: ExtractedArtwork | undefined;
  let durationMs: number | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;

  const moov = locateMoov(head, tail);
  if (!moov) {
    warnings.push('moov atom not found in the inspected windows; tags and duration unavailable.');
    return { tags, warnings };
  }
  const bytes = moov.bytes;

  const mvhd = findChild(bytes, moov.box, 'mvhd');
  if (mvhd) {
    const version = bytes[mvhd.contentStart]!;
    if (version === 1) {
      sampleRate = readUint32(bytes, mvhd.contentStart + 20);
      const duration = readUint64(bytes, mvhd.contentStart + 24);
      if (sampleRate > 0 && duration > 0) durationMs = Math.round((duration / sampleRate) * 1000);
    } else {
      sampleRate = readUint32(bytes, mvhd.contentStart + 12);
      const duration = readUint32(bytes, mvhd.contentStart + 16);
      if (sampleRate > 0 && duration > 0) durationMs = Math.round((duration / sampleRate) * 1000);
    }
  }

  // Track-level media header gives the audio sample rate even when mvhd is odd.
  const trak = findChild(bytes, moov.box, 'trak');
  if (trak) {
    const mdia = findChild(bytes, trak, 'mdia');
    if (mdia) {
      const mdhd = findChild(bytes, mdia, 'mdhd');
      if (mdhd) {
        const version = bytes[mdhd.contentStart]!;
        const timescale = version === 1 ? readUint32(bytes, mdhd.contentStart + 20) : readUint32(bytes, mdhd.contentStart + 12);
        if (timescale > 0) sampleRate ??= timescale;
      }
      const hdlr = findChild(bytes, mdia, 'hdlr');
      if (hdlr) {
        const handler = boxType(bytes, hdlr.contentStart + 8);
        if (handler !== 'soun') {
          warnings.push(`Primary track handler is "${handler}" rather than audio.`);
        }
      }

      // stsd → AudioSampleEntry: channelcount at +16, samplesize at +18,
      // sample rate as 16.16 fixed point at +24 (relative to the entry content).
      const minf = findChild(bytes, mdia, 'minf');
      const stbl = minf ? findChild(bytes, minf, 'stbl') : null;
      const stsd = stbl ? findChild(bytes, stbl, 'stsd') : null;
      if (stsd) {
        // stsd is a FullBox: version/flags (4) then entry_count (4).
        for (const entry of iterateBoxes(bytes, stsd.contentStart + 8, stsd.end)) {
          const base = entry.contentStart;
          if (base + 28 > entry.end) break;
          const channelCount = readUint16(bytes, base + 16);
          const entryRate = readUint32(bytes, base + 24) >>> 16;
          if (channelCount > 0 && channelCount <= 32) channels = channelCount;
          if (entryRate > 0) sampleRate ??= entryRate;
          // samplesize in an AAC sample entry is the decoder output width, not a
          // property of the encoding, so bit depth is intentionally not reported.
          break;
        }
      }
    }
  }

  const udta = findChild(bytes, moov.box, 'udta');
  if (udta) {
    const meta = findChild(bytes, udta, 'meta');
    if (meta) {
      const ilst = findChild(bytes, { ...meta, contentStart: metaChildrenStart(bytes, meta) }, 'ilst');
      if (ilst) {
        for (const item of iterateBoxes(bytes, ilst.contentStart, ilst.end)) {
          const data = findChild(bytes, item, 'data');
          if (!data || data.contentStart + 8 > data.end) continue;
          const dataType = readUint32(bytes, data.contentStart);
          const payload = bytes.subarray(data.contentStart + 8, data.end);

          if (item.type === 'trkn' && payload.length >= 4) {
            const track = (payload[2]! << 8) | payload[3]!;
            if (track > 0) tags.trackNumber = track;
            continue;
          }
          if (item.type === 'disk' && payload.length >= 4) {
            const disc = (payload[2]! << 8) | payload[3]!;
            if (disc > 0) tags.discNumber = disc;
            continue;
          }
          if (item.type === 'covr') {
            if (payload.byteLength > MAX_ARTWORK_BYTES) {
              warnings.push('Embedded artwork exceeds the maximum stored size and was ignored.');
              continue;
            }
            const mime = dataType === 14 ? 'image/png' : dataType === 13 ? 'image/jpeg' : detectImageMime(payload);
            artwork = { mime, data: payload.slice() };
            continue;
          }

          const mapped = TEXT_ATOMS[item.type];
          if (mapped && dataType === 1) {
            const value = decodeText(payload);
            if (!value) continue;
            if (mapped === 'year') {
              const year = /\d{4}/.exec(value);
              if (year) tags.year = Number(year[0]);
            } else {
              (tags as Record<string, string | number | undefined>)[mapped] = value;
            }
          }
        }
      }
    }
  }

  return {
    tags,
    ...(artwork ? { artwork } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    warnings,
  };
}

function detectImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  return 'image/jpeg';
}
