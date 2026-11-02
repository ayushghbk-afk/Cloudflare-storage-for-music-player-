import { MAX_ARTWORK_BYTES, type AudioTags, type ExtractedArtwork } from './types';

/**
 * FLAC metadata block parser: STREAMINFO (audio facts), VORBIS_COMMENT (tags),
 * PICTURE (artwork). Metadata blocks are all at the start of a FLAC file, so a
 * leading window is enough.
 */
export interface FlacResult {
  tags: AudioTags;
  artwork?: ExtractedArtwork;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  bitrateKbps?: number;
  warnings: string[];
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function parseFlac(bytes: Uint8Array, fileSize: number): FlacResult | null {
  let offset = 0;
  // Some encoders prepend an ID3v2 tag to FLAC files.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    offset = 10 + size;
  }

  if (!(bytes[offset] === 0x66 && bytes[offset + 1] === 0x4c && bytes[offset + 2] === 0x61 && bytes[offset + 3] === 0x43)) {
    return null;
  }
  offset += 4;

  const tags: AudioTags = {};
  const warnings: string[] = [];
  let artwork: ExtractedArtwork | undefined;
  let durationMs: number | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bitDepth: number | undefined;

  let isLast = false;
  let guard = 0;

  while (!isLast && offset + 4 <= bytes.length && guard < 128) {
    guard += 1;
    const header = bytes[offset]!;
    isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const length = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const start = offset + 4;
    const end = start + length;
    if (end > bytes.length) {
      warnings.push('FLAC metadata block extends beyond the inspected window.');
      break;
    }

    if (blockType === 0 && length >= 34) {
      // STREAMINFO
      const bits = readUint32BE(bytes, start + 10); // sampleRate(20) | channels(3) | bitsPerSample(5) | totalSamples high(4)
      sampleRate = bits >>> 12;
      channels = ((bits >>> 9) & 0x07) + 1;
      bitDepth = ((bits >>> 4) & 0x1f) + 1;
      const totalSamples = (bits & 0x0f) * 2 ** 32 + readUint32BE(bytes, start + 14);
      if (sampleRate > 0 && totalSamples > 0) {
        durationMs = Math.round((totalSamples / sampleRate) * 1000);
      }
    } else if (blockType === 4 && length > 8) {
      // VORBIS_COMMENT
      let cursor = start;
      const vendorLength = readUint32LE(bytes, cursor);
      cursor += 4 + vendorLength;
      if (cursor + 4 <= end) {
        const count = readUint32LE(bytes, cursor);
        cursor += 4;
        for (let i = 0; i < count && cursor + 4 <= end; i += 1) {
          const commentLength = readUint32LE(bytes, cursor);
          cursor += 4;
          if (cursor + commentLength > end) break;
          const comment = decodeUtf8(bytes.subarray(cursor, cursor + commentLength));
          cursor += commentLength;
          const separator = comment.indexOf('=');
          if (separator <= 0) continue;
          const key = comment.slice(0, separator).toUpperCase();
          const value = comment.slice(separator + 1).trim();
          if (!value) continue;
          switch (key) {
            case 'TITLE':
              tags.title ??= value;
              break;
            case 'ARTIST':
              tags.artist ??= value;
              break;
            case 'ALBUM':
              tags.album ??= value;
              break;
            case 'ALBUMARTIST':
              tags.albumArtist ??= value;
              break;
            case 'GENRE':
              tags.genre ??= value;
              break;
            case 'DATE':
            case 'YEAR': {
              const year = /\d{4}/.exec(value);
              if (year) tags.year ??= Number(year[0]);
              break;
            }
            case 'TRACKNUMBER': {
              const track = /\d+/.exec(value);
              if (track) tags.trackNumber ??= Number(track[0]);
              break;
            }
            case 'DISCNUMBER': {
              const disc = /\d+/.exec(value);
              if (disc) tags.discNumber ??= Number(disc[0]);
              break;
            }
            case 'COMMENT':
            case 'DESCRIPTION':
              tags.comment ??= value;
              break;
            default:
              break;
          }
        }
      }
    } else if (blockType === 6 && length > 32) {
      // PICTURE
      let cursor = start;
      cursor += 4; // picture type
      const mimeLength = readUint32BE(bytes, cursor);
      cursor += 4;
      const mime = decodeUtf8(bytes.subarray(cursor, cursor + mimeLength)) || 'image/jpeg';
      cursor += mimeLength;
      const descriptionLength = readUint32BE(bytes, cursor);
      cursor += 4 + descriptionLength;
      cursor += 16; // width, height, depth, colors
      const dataLength = readUint32BE(bytes, cursor);
      cursor += 4;
      if (dataLength > 0 && cursor + dataLength <= end) {
        if (dataLength > MAX_ARTWORK_BYTES) {
          warnings.push('Embedded artwork exceeds the maximum stored size and was ignored.');
        } else {
          artwork = { mime: mime.startsWith('image/') ? mime : 'image/jpeg', data: bytes.subarray(cursor, cursor + dataLength).slice() };
        }
      }
    }

    offset = end;
  }

  const bitrateKbps =
    durationMs && durationMs > 0 ? Math.round((Math.max(0, fileSize - offset) * 8) / durationMs) : undefined;

  return {
    tags,
    ...(artwork ? { artwork } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(bitDepth !== undefined ? { bitDepth } : {}),
    ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
    warnings,
  };
}
