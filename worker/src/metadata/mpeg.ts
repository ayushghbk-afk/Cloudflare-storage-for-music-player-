/**
 * MPEG audio (MP3) frame header parsing: sample rate, bitrate, channels and
 * duration. Handles CBR by arithmetic and VBR through Xing/Info/VBRI headers.
 */
export interface MpegFrameHeader {
  version: 1 | 2 | 25;
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  padding: number;
  frameLength: number;
  samplesPerFrame: number;
}

export interface MpegInfo {
  durationMs?: number;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  frameCount?: number;
  isVbr: boolean;
  /** Offset of the first valid frame within the inspected buffer. */
  audioStart: number;
}

const BITRATES: Record<string, number[]> = {
  // index 1..14 (0 = free, 15 = bad)
  '1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '25': [11025, 12000, 8000],
};

export function parseMpegFrameHeader(bytes: Uint8Array, offset: number): MpegFrameHeader | null {
  if (offset + 4 > bytes.length) return null;
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;

  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;

  const version: 1 | 2 | 25 = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const versionKey = version === 1 ? '1' : '2';
  const bitrateKbps = BITRATES[`${versionKey}-${layer}`]?.[bitrateIndex - 1];
  const sampleRate = SAMPLE_RATES[String(version)]?.[sampleRateIndex];
  if (!bitrateKbps || !sampleRate) return null;

  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03;
  const channels = channelMode === 3 ? 1 : 2;

  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
  const frameLength =
    layer === 1
      ? Math.floor((12 * bitrateKbps * 1000) / sampleRate + padding) * 4
      : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrateKbps * 1000) / sampleRate + padding);

  if (frameLength <= 4) return null;

  return { version, layer, bitrateKbps, sampleRate, channels, padding, frameLength, samplesPerFrame };
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** Locate the first MPEG frame, skipping an ID3v2 tag when present. */
export function findFirstFrame(bytes: Uint8Array, start = 0): number {
  for (let i = start; i + 4 < bytes.length && i < start + 65_536; i += 1) {
    if (bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0) {
      const header = parseMpegFrameHeader(bytes, i);
      if (header) return i;
    }
  }
  return -1;
}

/**
 * @param bytes     leading window of the file (512 KiB is plenty for the header)
 * @param fileSize  total object size, used for the CBR duration estimate
 */
export function inspectMpeg(bytes: Uint8Array, fileSize: number): MpegInfo {
  const audioStart = findFirstFrame(bytes);
  if (audioStart < 0) return { isVbr: false, audioStart: 0 };

  const header = parseMpegFrameHeader(bytes, audioStart);
  if (!header) return { isVbr: false, audioStart };

  const sideInfo = header.version === 1 ? (header.channels === 1 ? 17 : 32) : header.channels === 1 ? 9 : 17;
  const xingOffset = audioStart + 4 + sideInfo;
  const xingTag = asciiAt(bytes, xingOffset, 4);

  if (xingTag === 'Xing' || xingTag === 'Info') {
    const flags = readUint32BE(bytes, xingOffset + 4);
    let cursor = xingOffset + 8;
    if (flags & 0x0001) {
      const frameCount = readUint32BE(bytes, cursor);
      cursor += 4;
      if (frameCount > 0) {
        const durationMs = Math.round((frameCount * header.samplesPerFrame * 1000) / header.sampleRate);
        let bitrateKbps = header.bitrateKbps;
        if (flags & 0x0002) {
          const byteCount = readUint32BE(bytes, cursor);
          if (byteCount > 0 && durationMs > 0) bitrateKbps = Math.round((byteCount * 8) / durationMs);
        }
        return {
          durationMs,
          bitrateKbps,
          sampleRate: header.sampleRate,
          channels: header.channels,
          frameCount,
          isVbr: xingTag === 'Xing',
          audioStart,
        };
      }
    }
    return {
      bitrateKbps: header.bitrateKbps,
      sampleRate: header.sampleRate,
      channels: header.channels,
      isVbr: xingTag === 'Xing',
      audioStart,
    };
  }

  // VBRI (Fraunhofer) header lives 32 bytes after the frame header.
  const vbriOffset = audioStart + 4 + 32;
  if (asciiAt(bytes, vbriOffset, 4) === 'VBRI') {
    const frameCount = readUint32BE(bytes, vbriOffset + 14);
    if (frameCount > 0) {
      return {
        durationMs: Math.round((frameCount * header.samplesPerFrame * 1000) / header.sampleRate),
        bitrateKbps: header.bitrateKbps,
        sampleRate: header.sampleRate,
        channels: header.channels,
        frameCount,
        isVbr: true,
        audioStart,
      };
    }
  }

  // CBR estimate from the size of the audio payload.
  const audioBytes = Math.max(0, fileSize - audioStart);
  const durationMs = audioBytes > 0 ? Math.round((audioBytes * 8) / header.bitrateKbps) : undefined;
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    bitrateKbps: header.bitrateKbps,
    sampleRate: header.sampleRate,
    channels: header.channels,
    isVbr: false,
    audioStart,
  };
}
