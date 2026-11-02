import type { AudioFormat } from './types';

/**
 * Container sniffing from the leading bytes.
 *
 * Used to verify that an upload really is the format it claims to be — the
 * declared Content-Type and file extension are attacker controlled.
 */
export function sniffFormat(bytes: Uint8Array): { format: AudioFormat; container: string } | null {
  if (bytes.length < 12) return null;

  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));

  // ID3v2-tagged MP3 (the audio frames follow the tag)
  if (ascii(0, 3) === 'ID3') {
    return { format: 'mp3', container: 'MPEG audio with ID3v2 tag' };
  }
  if (ascii(0, 4) === 'fLaC') return { format: 'flac', container: 'FLAC' };
  if (ascii(0, 4) === 'OggS') {
    // The first page payload starts at byte 27 plus the segment table length.
    const segmentCount = bytes[26] ?? 0;
    const payloadStart = 27 + segmentCount;
    if (payloadStart + 8 <= bytes.length) {
      if (ascii(payloadStart, 8) === 'OpusHead') return { format: 'opus', container: 'Ogg Opus' };
      if (ascii(payloadStart + 1, 6) === 'vorbis') return { format: 'ogg', container: 'Ogg Vorbis' };
    }
    return { format: 'ogg', container: 'Ogg' };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { format: 'wav', container: 'RIFF/WAVE' };
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return { format: 'm4a', container: `ISO BMFF (${brand.trim()})` };
    if (brand === 'qt  ') return { format: 'm4a', container: 'QuickTime' };
    return { format: 'm4a', container: `ISO BMFF (${brand.trim()})` };
  }

  // Raw MPEG / ADTS frame sync
  if (bytes[0] === 0xff) {
    const second = bytes[1] ?? 0;
    const isAdts = (second & 0xf6) === 0xf0;
    const isMpegAudio = (second & 0xe0) === 0xe0;
    if (isAdts) return { format: 'aac', container: 'ADTS AAC' };
    if (isMpegAudio) return { format: 'mp3', container: 'MPEG audio' };
  }

  return null;
}

/** Map a filename extension to the format it should be. */
export function formatFromExtension(filename: string): AudioFormat {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp3':
      return 'mp3';
    case 'flac':
      return 'flac';
    case 'm4a':
    case 'mp4':
    case 'm4b':
      return 'm4a';
    case 'aac':
      return 'aac';
    case 'ogg':
    case 'oga':
      return 'ogg';
    case 'opus':
      return 'opus';
    case 'wav':
    case 'wave':
      return 'wav';
    default:
      return 'unknown';
  }
}
