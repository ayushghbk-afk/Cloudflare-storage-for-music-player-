export type AudioFormat = 'mp3' | 'flac' | 'm4a' | 'aac' | 'ogg' | 'opus' | 'wav' | 'unknown';

export interface ExtractedArtwork {
  mime: string;
  data: Uint8Array;
}

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  comment?: string;
}

export interface AudioMetadata {
  format: AudioFormat;
  /** Canonical MIME type for the detected container/codec. */
  mimeType: string;
  tags: AudioTags;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  bitrateKbps?: number;
  artwork?: ExtractedArtwork;
  /** Non-fatal problems discovered while parsing (surfaced to moderators/logs). */
  warnings: string[];
}

export const FORMAT_MIME: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  unknown: 'application/octet-stream',
};

export const FORMAT_EXTENSION: Record<AudioFormat, string> = {
  mp3: 'mp3',
  flac: 'flac',
  m4a: 'm4a',
  aac: 'aac',
  ogg: 'ogg',
  opus: 'opus',
  wav: 'wav',
  unknown: 'bin',
};

/** Guard against absurd embedded artwork sizes (bots/padding). */
export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
