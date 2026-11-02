import { parseFlac } from './flac';
import { parseId3v1, parseId3v2 } from './id3';
import { parseMp4 } from './mp4';
import { inspectMpeg } from './mpeg';
import { parseOgg, parseWav } from './other';
import { formatFromExtension, sniffFormat } from './sniff';
import { FORMAT_MIME, type AudioMetadata, type AudioTags, type AudioFormat } from './types';

export * from './types';
export { sniffFormat, formatFromExtension } from './sniff';
export { inspectMpeg, parseMpegFrameHeader } from './mpeg';
export { parseId3v2, parseId3v1 } from './id3';
export { parseFlac } from './flac';
export { parseMp4 } from './mp4';

export interface MetadataInput {
  /** Leading bytes of the object (ID3 tags, FLAC blocks, ftyp/moov). */
  head: Uint8Array;
  /** Trailing bytes of the object (ID3v1, trailing moov, last Ogg page). */
  tail: Uint8Array;
  /** Total object size in bytes. */
  fileSize: number;
  /** Original filename, used only as a weak fallback hint. */
  filename?: string;
}

function mergeTags(primary: AudioTags, fallback: AudioTags): AudioTags {
  const merged: AudioTags = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    if (value !== undefined && value !== '') {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * Detect the container and extract everything the catalogue needs, using only the
 * head/tail windows so no audio file is ever fully downloaded.
 */
export function extractMetadata(input: MetadataInput): AudioMetadata {
  const warnings: string[] = [];
  const sniffed = sniffFormat(input.head);
  const extensionFormat = input.filename ? formatFromExtension(input.filename) : 'unknown';
  const format: AudioFormat = sniffed?.format ?? extensionFormat;

  let tags: AudioTags = {};
  let durationMs: number | undefined;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let bitDepth: number | undefined;
  let bitrateKbps: number | undefined;
  let artwork: AudioMetadata['artwork'];

  if (format === 'mp3') {
    const id3 = parseId3v2(input.head);
    if (id3) {
      tags = id3.tags;
      artwork = id3.artwork;
      warnings.push(...id3.warnings);
    }
    const mpeg = inspectMpeg(input.head, input.fileSize);
    durationMs = mpeg.durationMs;
    sampleRate = mpeg.sampleRate;
    channels = mpeg.channels;
    bitrateKbps = mpeg.bitrateKbps;

    if (!id3 || Object.keys(tags).length === 0) {
      const v1 = parseId3v1(input.tail);
      if (v1) tags = mergeTags(tags, v1);
    }
  } else if (format === 'flac') {
    const flac = parseFlac(input.head, input.fileSize);
    if (flac) {
      tags = flac.tags;
      artwork = flac.artwork;
      durationMs = flac.durationMs;
      sampleRate = flac.sampleRate;
      channels = flac.channels;
      bitDepth = flac.bitDepth;
      bitrateKbps = flac.bitrateKbps;
      warnings.push(...flac.warnings);
    } else {
      warnings.push('FLAC signature not found where expected.');
    }
  } else if (format === 'm4a' || format === 'aac') {
    const mp4 = parseMp4(input.head, input.tail);
    if (mp4) {
      tags = mp4.tags;
      artwork = mp4.artwork;
      durationMs = mp4.durationMs;
      sampleRate = mp4.sampleRate;
      channels = mp4.channels;
      warnings.push(...mp4.warnings);
    }
    if (durationMs && durationMs > 0) {
      bitrateKbps = Math.round((input.fileSize * 8) / durationMs);
    }
  } else if (format === 'ogg' || format === 'opus') {
    const ogg = parseOgg(input.head, input.tail);
    tags = ogg.tags;
    durationMs = ogg.durationMs;
    sampleRate = ogg.sampleRate;
    channels = ogg.channels;
    warnings.push(...ogg.warnings);
    if (durationMs && durationMs > 0) bitrateKbps = Math.round((input.fileSize * 8) / durationMs);
  } else if (format === 'wav') {
    const wav = parseWav(input.head, input.fileSize);
    tags = wav.tags;
    durationMs = wav.durationMs;
    sampleRate = wav.sampleRate;
    channels = wav.channels;
    bitDepth = wav.bitDepth;
    warnings.push(...wav.warnings);
  } else {
    warnings.push('Unsupported or unrecognised audio container.');
  }

  if (sniffed && extensionFormat !== 'unknown' && sniffed.format !== extensionFormat) {
    warnings.push(`File extension suggests ${extensionFormat} but the content is ${sniffed.format}.`);
  }

  const finalFormat: AudioFormat = format;

  return {
    format: finalFormat,
    mimeType: FORMAT_MIME[finalFormat],
    tags,
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    ...(sampleRate ? { sampleRate } : {}),
    ...(channels ? { channels } : {}),
    ...(bitDepth ? { bitDepth } : {}),
    ...(bitrateKbps && bitrateKbps > 0 ? { bitrateKbps } : {}),
    ...(artwork ? { artwork } : {}),
    warnings,
  };
}

/**
 * Verify that the bytes on the wire match what the uploader declared.
 * Returns null when they agree, or a human readable reason when they do not.
 */
export function verifyDeclaredFormat(head: Uint8Array, declaredMime: string, filename: string): string | null {
  const sniffed = sniffFormat(head);
  if (!sniffed) {
    return 'The file content is not a recognised audio format (MP3, FLAC, M4A, AAC, OGG, Opus or WAV).';
  }
  const actualMime = FORMAT_MIME[sniffed.format];
  const normalisedDeclared = declaredMime.toLowerCase().split(';')[0]!.trim();
  const acceptable = new Set([actualMime, ...equivalentMimeTypes(sniffed.format)]);
  if (!acceptable.has(normalisedDeclared)) {
    return `Declared content type "${declaredMime}" does not match the detected format (${actualMime}).`;
  }
  const extensionFormat = formatFromExtension(filename);
  if (extensionFormat !== 'unknown' && extensionFormat !== sniffed.format) {
    const compatiblePair =
      (extensionFormat === 'm4a' && sniffed.format === 'aac') || (extensionFormat === 'ogg' && sniffed.format === 'opus');
    if (!compatiblePair) {
      return `File extension does not match the detected format (${sniffed.format}).`;
    }
  }
  return null;
}

function equivalentMimeTypes(format: AudioFormat): string[] {
  switch (format) {
    case 'mp3':
      return ['audio/mp3', 'audio/mpeg3', 'audio/x-mpeg'];
    case 'flac':
      return ['audio/x-flac', 'audio/flac'];
    case 'm4a':
      return ['audio/x-m4a', 'audio/m4a', 'audio/mp4a-latm', 'video/mp4'];
    case 'aac':
      return ['audio/aacp', 'audio/x-aac'];
    case 'ogg':
      return ['audio/vorbis', 'application/ogg'];
    case 'opus':
      return ['audio/ogg', 'audio/x-opus'];
    case 'wav':
      return ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'];
    default:
      return [];
  }
}
