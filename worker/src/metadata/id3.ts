import { MAX_ARTWORK_BYTES, type AudioTags, type ExtractedArtwork } from './types';

/**
 * ID3v2.2 / v2.3 / v2.4 tag parser.
 *
 * Supports: text frames (with all four text encodings), APIC/[...]PIC artwork,
 * unsynchronisation, extended headers and the "footer" flag. It intentionally
 * ignores frames it does not need instead of failing, because real-world files
 * carry a lot of junk.
 */
export interface Id3Result {
  tags: AudioTags;
  artwork?: ExtractedArtwork;
  /** Total bytes consumed by the tag (frames start after this). */
  tagSize: number;
  warnings: string[];
}

const TEXT_FRAME_MAP: Record<string, keyof AudioTags> = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TALB: 'album',
  TAL: 'album',
  TPE2: 'albumArtist',
  TP2: 'albumArtist',
  TCON: 'genre',
  TCO: 'genre',
  TDRC: 'year',
  TYER: 'year',
  TYE: 'year',
  TRCK: 'trackNumber',
  TRK: 'trackNumber',
  TPOS: 'discNumber',
  TPA: 'discNumber',
  COMM: 'comment',
  COM: 'comment',
};

function syncSafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! & 0x7f) << 21) |
    ((bytes[offset + 1]! & 0x7f) << 14) |
    ((bytes[offset + 2]! & 0x7f) << 7) |
    (bytes[offset + 3]! & 0x7f)
  );
}

function plainSize(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = (value << 8) | bytes[offset + i]!;
  return value;
}

function removeUnsynchronisation(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let written = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    out[written++] = bytes[i]!;
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i += 1;
  }
  return out.subarray(0, written);
}

function decodeText(payload: Uint8Array, encoding: number): string {
  if (payload.length === 0) return '';
  switch (encoding) {
    case 0:
      return new TextDecoder('iso-8859-1').decode(payload);
    case 1: {
      // UTF-16 with BOM
      if (payload[0] === 0xff && payload[1] === 0xfe) return new TextDecoder('utf-16le').decode(payload.subarray(2));
      if (payload[0] === 0xfe && payload[1] === 0xff) return new TextDecoder('utf-16be').decode(payload.subarray(2));
      return new TextDecoder('utf-16le').decode(payload);
    }
    case 2:
      return new TextDecoder('utf-16be').decode(payload);
    case 3:
    default:
      return new TextDecoder('utf-8').decode(payload);
  }
}

/** Split a null-terminated string from the start of `bytes`, honouring encoding width. */
function splitTerminated(bytes: Uint8Array, encoding: number): { value: string; rest: Uint8Array } {
  const wide = encoding === 1 || encoding === 2;
  for (let i = 0; i + (wide ? 1 : 0) < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) {
      const value = decodeText(bytes.subarray(0, i), encoding);
      return { value, rest: bytes.subarray(i + (wide ? 2 : 1)) };
    }
  }
  return { value: decodeText(bytes, encoding), rest: new Uint8Array(0) };
}

function trimNulls(value: string): string {
  // eslint-disable-next-line no-control-regex -- trailing NUL padding is meaningful in ID3
  return value.replace(/\u0000+$/g, '').trim();
}

function firstNumber(value: string): number | undefined {
  const match = /\d+/.exec(value);
  return match ? Number(match[0]) : undefined;
}

function parseGenre(value: string): string | undefined {
  const trimmed = trimNulls(value);
  if (!trimmed) return undefined;
  // ID3v1 numeric genre references such as "(13)Pop"
  const numeric = /^\((\d+)\)(.*)$/.exec(trimmed);
  if (numeric) {
    const name = numeric[2]?.trim();
    return name && name.length > 0 ? name : undefined;
  }
  return trimmed;
}

export function parseId3v2(bytes: Uint8Array): Id3Result | null {
  if (bytes.length < 10) return null;
  if (!(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)) return null; // "ID3"

  const major = bytes[3]!;
  const flags = bytes[5]!;
  if (major < 2 || major > 4) return null;

  const tagSize = syncSafe(bytes, 6);
  const totalSize = tagSize + 10 + (flags & 0x10 ? 10 : 0); // footer
  const warnings: string[] = [];
  const tags: AudioTags = {};
  let artwork: ExtractedArtwork | undefined;

  let body = bytes.subarray(10, Math.min(bytes.length, 10 + tagSize));
  if (flags & 0x80) body = removeUnsynchronisation(body);

  let offset = 0;
  // Skip extended header (v2.3 length is plain, v2.4 is syncsafe)
  if (flags & 0x40) {
    if (major === 4) offset += syncSafe(body, 0) + 4;
    else offset += plainSize(body, 0, 4) + 4;
  }

  const headerLength = major === 2 ? 6 : 10;

  while (offset + headerLength <= body.length) {
    const frameId =
      major === 2
        ? String.fromCharCode(body[offset]!, body[offset + 1]!, body[offset + 2]!)
        : String.fromCharCode(body[offset]!, body[offset + 1]!, body[offset + 2]!, body[offset + 3]!);
    if (frameId.charCodeAt(0) === 0) break;

    const size =
      major === 2
        ? plainSize(body, offset + 3, 3)
        : major === 4
          ? syncSafe(body, offset + 4)
          : plainSize(body, offset + 4, 4);

    if (size <= 0 || offset + headerLength + size > body.length) break;

    const frame = body.subarray(offset + headerLength, offset + headerLength + size);
    offset += headerLength + size;

    const mapping = TEXT_FRAME_MAP[frameId];
    if (mapping && frame.length > 1) {
      const encoding = frame[0]!;
      let payload = frame.subarray(1);
      if (frameId === 'COMM' || frameId === 'COM') {
        // language(3) + short description + text
        const withoutLanguage = payload.subarray(3);
        const split = splitTerminated(withoutLanguage, encoding);
        payload = split.rest;
      }
      const decoded = trimNulls(decodeText(payload, encoding));
      if (!decoded) continue;

      if (mapping === 'year') {
        const year = firstNumber(decoded);
        if (year !== undefined) tags.year = year > 9999 ? undefined : year;
      } else if (mapping === 'trackNumber' || mapping === 'discNumber') {
        const number = firstNumber(decoded);
        if (number !== undefined) tags[mapping] = number;
      } else if (mapping === 'genre') {
        const genre = parseGenre(decoded);
        if (genre) tags.genre = genre;
      } else {
        tags[mapping] = decoded;
      }
      continue;
    }

    const isApic = frameId === 'APIC' || frameId === 'PIC';
    if (isApic && frame.length > 4) {
      const parsed = parseApic(frame, major === 2);
      if (parsed) {
        if (parsed.data.byteLength > MAX_ARTWORK_BYTES) {
          warnings.push('Embedded artwork exceeds the maximum stored size and was ignored.');
        } else {
          artwork = parsed;
        }
      }
    }
  }

  return { tags, ...(artwork ? { artwork } : {}), tagSize: Math.max(totalSize, 10), warnings };
}

function parseApic(frame: Uint8Array, isV22: boolean): ExtractedArtwork | null {
  const encoding = frame[0]!;
  let offset = 1;
  let mime: string;

  if (isV22) {
    // PIC: 3-character image format ("JPG"/"PNG")
    const format = String.fromCharCode(frame[1]!, frame[2]!, frame[3]!).toUpperCase();
    offset = 4;
    mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
  } else {
    const mimeEnd = frame.indexOf(0, offset);
    if (mimeEnd < 0) return null;
    mime = new TextDecoder('iso-8859-1').decode(frame.subarray(offset, mimeEnd)) || 'image/jpeg';
    if (mime === 'image/jpg') mime = 'image/jpeg';
    offset = mimeEnd + 1;
  }

  offset += 1; // picture type
  const description = splitTerminated(frame.subarray(offset), encoding);
  const data = description.rest;
  if (data.byteLength < 8) return null;
  if (!mime.startsWith('image/')) mime = 'image/jpeg';
  return { mime, data: data.slice() };
}

/** Minimal ID3v1 tag reader (last 128 bytes of the file). */
export function parseId3v1(tail: Uint8Array): AudioTags | null {
  if (tail.length < 128) return null;
  const tag = tail.subarray(tail.length - 128);
  if (!(tag[0] === 0x54 && tag[1] === 0x41 && tag[2] === 0x47)) return null; // "TAG"

  const text = (start: number, length: number): string =>
    new TextDecoder('iso-8859-1')
      .decode(tag.subarray(start, start + length))
      // eslint-disable-next-line no-control-regex -- ID3v1 fields are NUL padded
      .replace(/\u0000.*$/s, '')
      .trim();

  const tags: AudioTags = {};
  const title = text(3, 30);
  const artist = text(33, 30);
  const album = text(63, 30);
  const year = text(93, 4);
  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  if (/^\d{4}$/.test(year)) tags.year = Number(year);

  // ID3v1.1 stores the track number in the last byte of the comment field.
  if (tag[125] === 0 && tag[126] !== 0) tags.trackNumber = tag[126]!;
  return Object.keys(tags).length > 0 ? tags : null;
}
