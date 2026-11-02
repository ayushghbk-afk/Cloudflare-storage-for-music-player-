import type { AudioTags } from './types';

/**
 * Lightweight Ogg (Vorbis/Opus) and RIFF/WAVE inspection.
 *
 * Ogg does not store a duration in its header; the granule position of the *last*
 * page does, which is why the caller provides a trailing window.
 */
export interface ContainerResult {
  tags: AudioTags;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  warnings: string[];
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function readUint64LE(bytes: Uint8Array, offset: number): number {
  const low = readUint32LE(bytes, offset);
  const high = readUint32LE(bytes, offset + 4);
  return high * 2 ** 32 + low;
}

export function parseOgg(head: Uint8Array, tail: Uint8Array): ContainerResult {
  const warnings: string[] = [];
  const tags: AudioTags = {};
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let preSkip = 0;
  let codec: 'opus' | 'vorbis' | 'unknown' = 'unknown';

  const segmentCount = head[26] ?? 0;
  const payloadStart = 27 + segmentCount;
  const magic = String.fromCharCode(...head.subarray(payloadStart, payloadStart + 8));

  if (magic === 'OpusHead') {
    codec = 'opus';
    channels = head[payloadStart + 9] ?? undefined;
    preSkip = (head[payloadStart + 10]! | (head[payloadStart + 11]! << 8)) >>> 0;
    sampleRate = 48000; // Opus granules are always at 48 kHz
  } else if (String.fromCharCode(...head.subarray(payloadStart + 1, payloadStart + 7)) === 'vorbis') {
    codec = 'vorbis';
    channels = head[payloadStart + 11] ?? undefined;
    sampleRate = readUint32LE(head, payloadStart + 12);
  } else {
    warnings.push('Unknown Ogg codec; duration may be unavailable.');
  }

  // Find the final page in the trailing window and read its granule position.
  let lastGranule = 0;
  for (let i = tail.length - 27; i >= 0; i -= 1) {
    if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
      lastGranule = readUint64LE(tail, i + 6);
      if (lastGranule > 0) break;
    }
  }

  let durationMs: number | undefined;
  if (sampleRate && lastGranule > 0) {
    const samples = codec === 'opus' ? Math.max(0, lastGranule - preSkip) : lastGranule;
    durationMs = Math.round((samples / sampleRate) * 1000);
  }

  return {
    tags,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    warnings,
  };
}

export function parseWav(head: Uint8Array, fileSize: number): ContainerResult {
  const warnings: string[] = [];
  const tags: AudioTags = {};
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bitDepth: number | undefined;
  let byteRate = 0;
  let dataSize = 0;

  let offset = 12;
  let guard = 0;
  while (offset + 8 <= head.length && guard < 64) {
    guard += 1;
    const id = String.fromCharCode(...head.subarray(offset, offset + 4));
    const size = readUint32LE(head, offset + 4);
    if (id === 'fmt ' && size >= 16) {
      channels = head[offset + 10]! | (head[offset + 11]! << 8);
      sampleRate = readUint32LE(head, offset + 12);
      byteRate = readUint32LE(head, offset + 16);
      bitDepth = head[offset + 22]! | (head[offset + 23]! << 8);
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
    if (offset > head.length) break;
  }

  if (dataSize === 0 && offset + 8 >= head.length) {
    warnings.push('WAV data chunk header not found in the inspected window.');
  }

  let durationMs: number | undefined;
  if (byteRate > 0) {
    const effectiveData = dataSize > 0 ? dataSize : Math.max(0, fileSize - offset - 8);
    if (effectiveData > 0) durationMs = Math.round((effectiveData / byteRate) * 1000);
  }

  return {
    tags,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(bitDepth !== undefined ? { bitDepth } : {}),
    warnings,
  };
}
