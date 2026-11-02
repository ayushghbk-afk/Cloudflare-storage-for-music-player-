import { payloadTooLarge, validationFailed } from '../utils/errors';
import { sanitizeFilename } from '../utils/text';
import type { Settings } from '../settings';
import { formatFromExtension, type AudioFormat } from '../metadata';

/**
 * Upload request validation.
 *
 * Everything a client sends about the file (name, size, MIME type) is untrusted.
 * These checks stop obviously invalid requests early and cheaply; the content
 * itself is re-verified from the actual bytes during `complete`.
 */
export interface UploadInitInput {
  filename: string;
  size: number;
  mimeType: string;
  rightsConfirmed: boolean;
}

export function normaliseMime(mime: string): string {
  return mime.toLowerCase().split(';')[0]!.trim();
}

/** Extensions that are plausible for a given detected/declared format. */
const FORMAT_EXTENSIONS: Record<AudioFormat, string[]> = {
  mp3: ['mp3', 'mpga'],
  flac: ['flac'],
  m4a: ['m4a', 'mp4', 'm4b'],
  aac: ['aac'],
  ogg: ['ogg', 'oga'],
  opus: ['opus', 'ogg'],
  wav: ['wav', 'wave'],
  unknown: [],
};

export function validateUploadInit(input: UploadInitInput, settings: Settings): void {
  const mime = normaliseMime(input.mimeType);

  if (!input.filename || input.filename.length < 3) {
    throw validationFailed('A filename is required.');
  }
  if (input.filename.length > 255) {
    throw validationFailed('Filename must be at most 255 characters.');
  }
  if (!Number.isInteger(input.size) || input.size <= 0) {
    throw validationFailed('A positive integer file size is required.');
  }
  if (input.size > settings.uploadMaxBytes) {
    throw payloadTooLarge(
      `File is ${input.size} bytes but the configured maximum is ${settings.uploadMaxBytes} bytes.`
    );
  }
  if (!settings.uploadAllowedMimeTypes.includes(mime)) {
    throw validationFailed(`Content type "${mime}" is not accepted for uploads.`, {
      allowed: settings.uploadAllowedMimeTypes,
    });
  }

  const extension = input.filename.split('.').pop()?.toLowerCase() ?? '';
  const declaredFormat = formatFromExtension(input.filename);
  if (declaredFormat === 'unknown') {
    throw validationFailed('Unrecognised file extension. Use MP3, FLAC, M4A, AAC, OGG, Opus or WAV.');
  }
  if (!FORMAT_EXTENSIONS[declaredFormat].includes(extension)) {
    throw validationFailed(`Extension ".${extension}" is not valid for ${declaredFormat.toUpperCase()} uploads.`);
  }

  if (settings.uploadRequireRightsConfirmation && !input.rightsConfirmed) {
    throw validationFailed(
      'You must confirm that you own or are licensed to distribute this recording before uploading.'
    );
  }
}

/** Deterministic, collision-free object key for a staged upload. */
export function uploadObjectKey(userId: string, jobId: string, filename: string): string {
  const safe = sanitizeFilename(filename, 'upload.bin');
  const extension = safe.includes('.') ? safe.split('.').pop()! : 'bin';
  return `audio/${userId}/${jobId}.${extension.toLowerCase()}`;
}

export function artworkObjectKey(trackId: string, mime: string): string {
  const extension = mime === 'image/png' ? 'png' : 'jpg';
  return `artwork/${trackId}.${extension}`;
}

export function isSupportedArtworkMime(mime: string): boolean {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(mime.toLowerCase());
}
