/**
 * Synthetic audio fixtures.
 *
 * These files are byte-accurate enough for the metadata parsers (ID3v2.3 frames,
 * FLAC metadata blocks, ISO-BMFF atoms) and for range/streaming tests, without
 * shipping any copyrighted recording in the repository.
 */

/** 1x1 PNG (67 bytes) used as embedded cover art. */
export const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** 1x1 JPEG-ish payload (only the SOI/EOI markers matter to our mime detection). */
export const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const ascii = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
  return out;
};

const concat = (...chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const u32be = (value: number): Uint8Array => new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const u32le = (value: number): Uint8Array => new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const u64be = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
};

const u64le = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
};

const syncSafe = (value: number): Uint8Array =>
  new Uint8Array([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);

/* -------------------------------------------------------------------------- */
/* ID3v2.3 + MPEG-1 Layer III                                                  */
/* -------------------------------------------------------------------------- */

function id3TextFrame(id: string, text: string): Uint8Array {
  const payload = concat(new Uint8Array([0x03]), new TextEncoder().encode(text)); // UTF-8
  return concat(ascii(id), u32be(payload.byteLength), new Uint8Array([0x00, 0x00]), payload);
}

function id3ApicFrame(mime: string, data: Uint8Array): Uint8Array {
  const payload = concat(
    new Uint8Array([0x00]), // ISO-8859-1
    ascii(mime),
    new Uint8Array([0x00]), // mime terminator
    new Uint8Array([0x03]), // picture type: front cover
    new Uint8Array([0x00]), // empty description
    data
  );
  return concat(ascii('APIC'), u32be(payload.byteLength), new Uint8Array([0x00, 0x00]), payload);
}

export function buildId3v23Tag(tags: Record<string, string>, artwork?: { mime: string; data: Uint8Array }): Uint8Array {
  const frames: Uint8Array[] = [];
  const map: Record<string, string> = {
    title: 'TIT2',
    artist: 'TPE1',
    album: 'TALB',
    albumArtist: 'TPE2',
    genre: 'TCON',
    year: 'TYER',
    trackNumber: 'TRCK',
    discNumber: 'TPOS',
  };
  for (const [key, id] of Object.entries(map)) {
    const value = tags[key];
    if (value !== undefined) frames.push(id3TextFrame(id, value));
  }
  if (artwork) frames.push(id3ApicFrame(artwork.mime, artwork.data));

  const body = concat(...frames);
  return concat(ascii('ID3'), new Uint8Array([0x03, 0x00, 0x00]), syncSafe(body.byteLength), body);
}

export interface Mp3Options {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: string;
  trackNumber?: string;
  artwork?: { mime: string; data: Uint8Array };
  /** Duration of the synthetic CBR stream. */
  durationSeconds?: number;
  includeId3v1?: boolean;
}

/**
 * Builds a CBR 128 kbit/s 44.1 kHz stereo MPEG-1 Layer III stream of silence with
 * an optional ID3v2.3 tag. Frame length is 417 bytes, 1152 samples per frame.
 */
export function buildMp3(options: Mp3Options = {}): Uint8Array {
  const durationSeconds = options.durationSeconds ?? 3;
  const tags: Record<string, string> = {};
  if (options.title) tags.title = options.title;
  if (options.artist) tags.artist = options.artist;
  if (options.album) tags.album = options.album;
  if (options.genre) tags.genre = options.genre;
  if (options.year) tags.year = options.year;
  if (options.trackNumber) tags.trackNumber = options.trackNumber;

  const tag = buildId3v23Tag(tags, options.artwork);
  const frameCount = Math.max(1, Math.round((durationSeconds * 44100) / 1152));
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const frames = new Uint8Array(frameCount * 417);
  for (let i = 0; i < frameCount; i += 1) frames.set(frame, i * 417);

  if (!options.includeId3v1) return concat(tag, frames);

  const v1 = new Uint8Array(128);
  const writeText = (offset: number, length: number, value: string): void => {
    const bytes = ascii(value).subarray(0, length);
    v1.set(bytes, offset);
  };
  v1[0] = 0x54;
  v1[1] = 0x41;
  v1[2] = 0x47; // "TAG"
  writeText(3, 30, options.title ?? '');
  writeText(33, 30, options.artist ?? '');
  writeText(63, 30, options.album ?? '');
  writeText(93, 4, options.year ?? '');
  return concat(tag, frames, v1);
}

/* -------------------------------------------------------------------------- */
/* FLAC                                                                       */
/* -------------------------------------------------------------------------- */

export interface FlacOptions {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: string;
  trackNumber?: string;
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  artwork?: { mime: string; data: Uint8Array };
}

export function buildFlac(options: FlacOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 2;
  const bitDepth = options.bitDepth ?? 16;
  const totalSamples = Math.round((options.durationSeconds ?? 3) * sampleRate);

  const streamInfoBody = new Uint8Array(34);
  streamInfoBody.set([0x10, 0x00, 0x10, 0x00], 0); // min/max block size 4096
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n) |
    BigInt(totalSamples);
  streamInfoBody.set(u64be(packed), 10);

  const vendor = new TextEncoder().encode('aether-test-fixture');
  const comments: Uint8Array[] = [];
  const add = (key: string, value?: string): void => {
    if (!value) return;
    const encoded = new TextEncoder().encode(`${key}=${value}`);
    comments.push(concat(u32le(encoded.byteLength), encoded));
  };
  add('TITLE', options.title);
  add('ARTIST', options.artist);
  add('ALBUM', options.album);
  add('GENRE', options.genre);
  add('DATE', options.year);
  add('TRACKNUMBER', options.trackNumber);
  const vorbisBody = concat(u32le(vendor.byteLength), vendor, u32le(comments.length), ...comments);

  const blocks: Uint8Array[] = [
    blockHeader(0, streamInfoBody.byteLength, false),
    streamInfoBody,
    blockHeader(4, vorbisBody.byteLength, false),
    vorbisBody,
  ];

  if (options.artwork) {
    const pictureBody = concat(
      u32be(3), // picture type: front cover
      u32be(options.artwork.mime.length),
      ascii(options.artwork.mime),
      u32be(0), // description length
      u32be(1),
      u32be(1),
      u32be(24),
      u32be(0),
      u32be(options.artwork.data.byteLength),
      options.artwork.data
    );
    blocks.push(blockHeader(6, pictureBody.byteLength, true), pictureBody);
  } else {
    // Mark the previous block as the last one.
    const header = blocks[2]!;
    header[0] = header[0]! | 0x80;
  }

  return concat(ascii('fLaC'), ...blocks);
}

function blockHeader(type: number, length: number, isLast: boolean): Uint8Array {
  return new Uint8Array([(isLast ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

/* -------------------------------------------------------------------------- */
/* M4A / MP4                                                                  */
/* -------------------------------------------------------------------------- */

const box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
  const body = concat(...payload);
  return concat(u32be(body.byteLength + 8), ascii(type), body);
};

const dataBox = (typeIndicator: number, payload: Uint8Array): Uint8Array =>
  box('data', u32be(typeIndicator), new Uint8Array([0, 0, 0, 0]), payload);

export interface M4aOptions {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: string;
  trackNumber?: number;
  durationSeconds?: number;
  sampleRate?: number;
  artwork?: { mime: string; data: Uint8Array };
  /** Put moov after mdat (tests the trailing-window parser). */
  moovAtEnd?: boolean;
}

export function buildM4a(options: M4aOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 44100;
  const durationMs = Math.round((options.durationSeconds ?? 3) * 1000);
  const totalSamples = Math.round((options.durationSeconds ?? 3) * sampleRate);

  const ftyp = box('ftyp', ascii('M4A '), u32be(512), ascii('M4A '), ascii('isom'));

  const mvhd = box(
    'mvhd',
    u32be(0), // version + flags
    u32be(0),
    u32be(0),
    u32be(1000),
    u32be(durationMs),
    u32be(0x00010000),
    new Uint8Array([0x01, 0x00]),
    new Uint8Array(10),
    new Uint8Array(36),
    new Uint8Array(24),
    u32be(2)
  );

  const mdhd = box(
    'mdhd',
    u32be(0),
    u32be(0),
    u32be(0),
    u32be(sampleRate),
    u32be(totalSamples),
    new Uint8Array([0x55, 0xc4, 0x00, 0x00])
  );

  const hdlr = box(
    'hdlr',
    u32be(0),
    u32be(0),
    ascii('soun'),
    new Uint8Array(12),
    ascii('SoundHandler\u0000')
  );

  const trak = box('trak', box('mdia', mdhd, hdlr));

  const items: Uint8Array[] = [];
  const text = (type: string, value?: string): void => {
    if (value === undefined) return;
    items.push(box(type, dataBox(1, new TextEncoder().encode(value))));
  };
  text('\u00a9nam', options.title);
  text('\u00a9ART', options.artist);
  text('\u00a9alb', options.album);
  text('\u00a9gen', options.genre);
  text('\u00a9day', options.year);
  if (options.trackNumber !== undefined) {
    items.push(
      box('trkn', dataBox(0, new Uint8Array([0x00, 0x00, (options.trackNumber >> 8) & 0xff, options.trackNumber & 0xff, 0x00, 0x00, 0x00, 0x00])))
    );
  }
  if (options.artwork) {
    const indicator = options.artwork.mime === 'image/png' ? 14 : 13;
    items.push(box('covr', dataBox(indicator, options.artwork.data)));
  }

  const ilst = box('ilst', ...items);
  const meta = box('meta', u32be(0), ilst);
  const udta = box('udta', meta);
  const moov = box('moov', mvhd, trak, udta);

  // ~4 KiB of "audio" so range requests have something to slice.
  const mdat = box('mdat', new Uint8Array(4096).fill(0x21));

  return options.moovAtEnd ? concat(ftyp, mdat, moov) : concat(ftyp, moov, mdat);
}

/* -------------------------------------------------------------------------- */
/* Ogg Opus / WAV                                                             */
/* -------------------------------------------------------------------------- */

export function buildOggOpus(durationSeconds = 2): Uint8Array {
  // Page header: 27 bytes + 1 byte segment table, then a 19-byte OpusHead.
  const head = new Uint8Array(28 + 19);
  head.set(ascii('OggS'), 0);
  head[4] = 0x00; // stream structure version
  head[5] = 0x02; // beginning of stream
  head[26] = 1; // one segment
  head[27] = 19; // that segment is 19 bytes long
  head.set(ascii('OpusHead'), 28);
  head[36] = 1; // OpusHead version
  head[37] = 2; // channel count

  // Pre-skip (312 samples) little endian at payload offset +10/+11.
  head[38] = 0x38;
  head[39] = 0x01;

  const last = new Uint8Array(28);
  last.set(ascii('OggS'), 0);
  last[5] = 0x04; // end of stream
  last.set(u64le(BigInt(Math.round(durationSeconds * 48000) + 312)), 6);

  return concat(head, new Uint8Array(256).fill(0x11), last);
}

export function buildWav(durationSeconds = 2, sampleRate = 44100, channels = 2, bitDepth = 16): Uint8Array {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const dataSize = Math.round(byteRate * durationSeconds);
  const fmt = concat(
    ascii('fmt '),
    u32le(16),
    new Uint8Array([0x01, 0x00]), // PCM
    new Uint8Array([channels & 0xff, (channels >> 8) & 0xff]),
    u32le(sampleRate),
    u32le(byteRate),
    new Uint8Array([(channels * bitDepth) / 8, 0x00]),
    new Uint8Array([bitDepth & 0xff, (bitDepth >> 8) & 0xff])
  );
  const dataHeader = concat(ascii('data'), u32le(dataSize));
  const data = new Uint8Array(dataSize).fill(0x08);
  const riffSize = 4 + fmt.byteLength + dataHeader.byteLength + data.byteLength;
  return concat(ascii('RIFF'), u32le(riffSize), ascii('WAVE'), fmt, dataHeader, data);
}
