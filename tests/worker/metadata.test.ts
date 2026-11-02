import { describe, expect, it } from 'vitest';
import { extractMetadata, formatFromExtension, sniffFormat, verifyDeclaredFormat } from '../../worker/src/metadata';
import { buildFlac, buildId3v23Tag, buildM4a, buildMp3, buildOggOpus, buildWav, TINY_JPEG, TINY_PNG } from '../support/audio';

const windows = (bytes: Uint8Array): { head: Uint8Array; tail: Uint8Array; fileSize: number } => ({
  head: bytes.subarray(0, 512 * 1024),
  tail: bytes.subarray(Math.max(0, bytes.byteLength - 256 * 1024)),
  fileSize: bytes.byteLength,
});

describe('container sniffing', () => {
  it('detects each supported container from its magic bytes', () => {
    expect(sniffFormat(buildMp3())?.format).toBe('mp3');
    expect(sniffFormat(buildFlac())?.format).toBe('flac');
    expect(sniffFormat(buildM4a())?.format).toBe('m4a');
    expect(sniffFormat(buildOggOpus())?.format).toBe('opus');
    expect(sniffFormat(buildWav())?.format).toBe('wav');
  });

  it('detects raw MPEG frames without a tag', () => {
    const raw = new Uint8Array(64);
    raw.set([0xff, 0xfb, 0x90, 0x00]);
    expect(sniffFormat(raw)?.format).toBe('mp3');
  });

  it('detects ADTS AAC', () => {
    const raw = new Uint8Array(64);
    raw.set([0xff, 0xf1, 0x50, 0x80]);
    expect(sniffFormat(raw)?.format).toBe('aac');
  });

  it('returns null for non-audio bytes', () => {
    expect(sniffFormat(new TextEncoder().encode('this is not audio at all'))).toBeNull();
    expect(sniffFormat(new Uint8Array(4))).toBeNull();
  });

  it('maps extensions to formats', () => {
    expect(formatFromExtension('a.MP3')).toBe('mp3');
    expect(formatFromExtension('a.flac')).toBe('flac');
    expect(formatFromExtension('a.m4a')).toBe('m4a');
    expect(formatFromExtension('a.ogg')).toBe('ogg');
    expect(formatFromExtension('a.opus')).toBe('opus');
    expect(formatFromExtension('a.wav')).toBe('wav');
    expect(formatFromExtension('a.txt')).toBe('unknown');
  });
});

describe('MP3 / ID3', () => {
  it('extracts ID3v2.3 text frames, duration and artwork', () => {
    const file = buildMp3({
      title: 'Midnight Signal',
      artist: 'Aether Collective',
      album: 'Night Drive',
      genre: 'Electronic',
      year: '2024',
      trackNumber: '3/12',
      durationSeconds: 5,
      artwork: { mime: 'image/jpeg', data: TINY_JPEG },
    });

    const metadata = extractMetadata({ ...windows(file), filename: 'midnight.mp3' });

    expect(metadata.format).toBe('mp3');
    expect(metadata.mimeType).toBe('audio/mpeg');
    expect(metadata.tags.title).toBe('Midnight Signal');
    expect(metadata.tags.artist).toBe('Aether Collective');
    expect(metadata.tags.album).toBe('Night Drive');
    expect(metadata.tags.genre).toBe('Electronic');
    expect(metadata.tags.year).toBe(2024);
    expect(metadata.tags.trackNumber).toBe(3);
    expect(metadata.sampleRate).toBe(44100);
    expect(metadata.channels).toBe(2);
    expect(metadata.bitrateKbps).toBe(128);
    // CBR estimate from the payload size: 5 s ± one frame.
    expect(metadata.durationMs).toBeGreaterThan(4700);
    expect(metadata.durationMs).toBeLessThan(5300);
    expect(metadata.artwork?.mime).toBe('image/jpeg');
    expect(metadata.artwork?.data.byteLength).toBe(TINY_JPEG.byteLength);
  });

  it('falls back to ID3v1 when no v2 tag is present', () => {
    const file = buildMp3({ title: 'Old Tag', artist: 'Legacy', album: 'Vintage', year: '1999', includeId3v1: true });
    const metadata = extractMetadata({ ...windows(file), filename: 'old.mp3' });
    expect(metadata.tags.title).toBe('Old Tag');
    expect(metadata.tags.artist).toBe('Legacy');
    expect(metadata.tags.year).toBe(1999);
  });

  it('warns when the extension disagrees with the content', () => {
    const file = buildMp3({ title: 'Mislabelled' });
    const metadata = extractMetadata({ ...windows(file), filename: 'track.flac' });
    expect(metadata.format).toBe('mp3');
    expect(metadata.warnings.join(' ')).toMatch(/extension/i);
  });

  it('parses a bare ID3 tag without audio frames safely', () => {
    const tag = buildId3v23Tag({ title: 'No Audio' });
    const metadata = extractMetadata({ ...windows(tag), filename: 'tag.mp3' });
    expect(metadata.tags.title).toBe('No Audio');
    expect(metadata.durationMs).toBeUndefined();
  });
});

describe('FLAC', () => {
  it('extracts STREAMINFO, Vorbis comments and a PICTURE block', () => {
    const file = buildFlac({
      title: 'Deep Current',
      artist: 'Aether Collective',
      album: 'Night Drive',
      genre: 'Ambient',
      year: '2023-05-01',
      trackNumber: '7',
      durationSeconds: 8,
      artwork: { mime: 'image/png', data: TINY_PNG },
    });

    const metadata = extractMetadata({ ...windows(file), filename: 'deep.flac' });

    expect(metadata.format).toBe('flac');
    expect(metadata.mimeType).toBe('audio/flac');
    expect(metadata.tags.title).toBe('Deep Current');
    expect(metadata.tags.artist).toBe('Aether Collective');
    expect(metadata.tags.year).toBe(2023);
    expect(metadata.tags.trackNumber).toBe(7);
    expect(metadata.sampleRate).toBe(44100);
    expect(metadata.channels).toBe(2);
    expect(metadata.bitDepth).toBe(16);
    expect(metadata.durationMs).toBe(8000);
    expect(metadata.artwork?.mime).toBe('image/png');
  });

  it('handles 24-bit 96 kHz files', () => {
    const file = buildFlac({ sampleRate: 96000, bitDepth: 24, channels: 1, durationSeconds: 2 });
    const metadata = extractMetadata({ ...windows(file), filename: 'hires.flac' });
    expect(metadata.sampleRate).toBe(96000);
    expect(metadata.bitDepth).toBe(24);
    expect(metadata.channels).toBe(1);
  });
});

describe('M4A / MP4', () => {
  it('parses a leading moov atom', () => {
    const file = buildM4a({
      title: 'Glass Horizon',
      artist: 'Aether Collective',
      album: 'Daylight',
      genre: 'Downtempo',
      year: '2022',
      trackNumber: 4,
      durationSeconds: 6,
      artwork: { mime: 'image/png', data: TINY_PNG },
    });

    const metadata = extractMetadata({ ...windows(file), filename: 'glass.m4a' });

    expect(metadata.format).toBe('m4a');
    expect(metadata.mimeType).toBe('audio/mp4');
    expect(metadata.tags.title).toBe('Glass Horizon');
    expect(metadata.tags.artist).toBe('Aether Collective');
    expect(metadata.tags.album).toBe('Daylight');
    expect(metadata.tags.trackNumber).toBe(4);
    expect(metadata.durationMs).toBe(6000);
    expect(metadata.artwork?.mime).toBe('image/png');
  });

  it('parses a trailing moov atom (streaming-optimised layout)', () => {
    const file = buildM4a({ title: 'Trailing Moov', durationSeconds: 4, moovAtEnd: true });
    const metadata = extractMetadata({ ...windows(file), filename: 'trailing.m4a' });
    expect(metadata.tags.title).toBe('Trailing Moov');
    expect(metadata.durationMs).toBe(4000);
  });
});

describe('Ogg and WAV', () => {
  it('reads the Opus granule position from the last page', () => {
    const file = buildOggOpus(2);
    const metadata = extractMetadata({ ...windows(file), filename: 'voice.opus' });
    expect(metadata.format).toBe('opus');
    expect(metadata.sampleRate).toBe(48000);
    expect(metadata.channels).toBe(2);
    expect(metadata.durationMs).toBe(2000);
  });

  it('reads WAV fmt and data chunks', () => {
    const file = buildWav(1, 48000, 2, 16);
    const metadata = extractMetadata({ ...windows(file), filename: 'clip.wav' });
    expect(metadata.format).toBe('wav');
    expect(metadata.sampleRate).toBe(48000);
    expect(metadata.channels).toBe(2);
    expect(metadata.bitDepth).toBe(16);
    expect(metadata.durationMs).toBe(1000);
  });
});

describe('declared format verification', () => {
  const mp3Head = buildMp3({ title: 'Check' }).subarray(0, 4096);

  it('accepts matching declarations and MIME aliases', () => {
    expect(verifyDeclaredFormat(mp3Head, 'audio/mpeg', 'a.mp3')).toBeNull();
    expect(verifyDeclaredFormat(mp3Head, 'audio/mpeg; charset=binary', 'a.mp3')).toBeNull();
    expect(verifyDeclaredFormat(mp3Head, 'audio/mp3', 'a.mp3')).toBeNull();
  });

  it('rejects a MIME type that contradicts the bytes', () => {
    expect(verifyDeclaredFormat(mp3Head, 'audio/flac', 'a.mp3')).toMatch(/does not match/);
    expect(verifyDeclaredFormat(mp3Head, 'image/png', 'a.mp3')).toMatch(/does not match/);
  });

  it('rejects an extension that contradicts the bytes', () => {
    expect(verifyDeclaredFormat(mp3Head, 'audio/mpeg', 'a.flac')).toMatch(/extension/);
  });

  it('rejects non-audio content outright', () => {
    const html = new TextEncoder().encode('<html><body>definitely not audio</body></html>');
    expect(verifyDeclaredFormat(html, 'audio/mpeg', 'evil.mp3')).toMatch(/not a recognised audio format/);
  });

  it('accepts ogg containers that hold Opus', () => {
    const opus = buildOggOpus(1).subarray(0, 1024);
    expect(verifyDeclaredFormat(opus, 'audio/ogg', 'a.ogg')).toBeNull();
    expect(verifyDeclaredFormat(opus, 'audio/opus', 'a.opus')).toBeNull();
  });
});
