import type { D1Database } from './platform';

/**
 * Admin-configurable settings stored in D1 (`app_settings`).
 *
 * Values are strings; typed accessors validate and fall back to safe defaults so
 * that a corrupt or partially seeded database can never widen limits silently.
 */
export interface Settings {
  uploadMaxBytes: number;
  uploadDailyUserQuotaBytes: number;
  uploadAllowedMimeTypes: string[];
  uploadRequireRightsConfirmation: boolean;
  autoPublishUploads: boolean;
  storageMigrationMaxBytes: number;
  streamUrlTtlSeconds: number;
  maxPlaylistsPerUser: number;
  maxTracksPerPlaylist: number;
}

export const SETTING_DEFAULTS: Settings = {
  // 50 MiB per file by default; raise deliberately in the admin settings panel.
  uploadMaxBytes: 52_428_800,
  uploadDailyUserQuotaBytes: 2_147_483_648,
  uploadAllowedMimeTypes: [
    'audio/mpeg',
    'audio/flac',
    'audio/x-flac',
    'audio/mp4',
    'audio/x-m4a',
    'audio/m4a',
    'audio/aac',
    'audio/ogg',
    'audio/opus',
    'audio/wav',
    'audio/x-wav',
  ],
  uploadRequireRightsConfirmation: true,
  // Uploads are private until a moderator approves them. Changing this is a
  // deliberate, audited admin action and is documented as a legal risk.
  autoPublishUploads: false,
  storageMigrationMaxBytes: 26_214_400,
  streamUrlTtlSeconds: 300,
  maxPlaylistsPerUser: 100,
  maxTracksPerPlaylist: 500,
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as (keyof Settings)[];

export const SETTING_DESCRIPTIONS: Record<keyof Settings, string> = {
  uploadMaxBytes: 'Maximum size of a single uploaded audio file, in bytes.',
  uploadDailyUserQuotaBytes: 'Maximum bytes a single user may upload per rolling 24h window.',
  uploadAllowedMimeTypes: 'JSON array of MIME types accepted for audio uploads.',
  uploadRequireRightsConfirmation: 'Require uploaders to confirm they hold distribution rights.',
  autoPublishUploads: 'Publish uploads without moderation. Keep false for legal safety.',
  storageMigrationMaxBytes:
    'Maximum object size copied between providers in one API request (larger files: use scripts/storage-copy.mjs).',
  streamUrlTtlSeconds: 'Lifetime of signed playback URLs.',
  maxPlaylistsPerUser: 'Maximum number of playlists a user may create.',
  maxTracksPerPlaylist: 'Maximum number of tracks in a playlist.',
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

function parseMimeTypes(raw: string | null | undefined): string[] {
  if (!raw) return SETTING_DEFAULTS.uploadAllowedMimeTypes;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return SETTING_DEFAULTS.uploadAllowedMimeTypes;
    const list = parsed.filter((entry): entry is string => typeof entry === 'string' && entry.includes('/'));
    return list.length > 0 ? list.map((entry) => entry.toLowerCase()) : SETTING_DEFAULTS.uploadAllowedMimeTypes;
  } catch {
    return SETTING_DEFAULTS.uploadAllowedMimeTypes;
  }
}

export function settingsFromRows(rows: { key: string; value: string }[]): Settings {
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const get = (key: keyof Settings): string | undefined => map.get(key);
  const bool = (key: keyof Settings, fallback: boolean): boolean => {
    const raw = get(key);
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  };

  return {
    uploadMaxBytes: clampNumber(get('uploadMaxBytes'), SETTING_DEFAULTS.uploadMaxBytes, 1_048_576, 2_147_483_648),
    uploadDailyUserQuotaBytes: clampNumber(
      get('uploadDailyUserQuotaBytes'),
      SETTING_DEFAULTS.uploadDailyUserQuotaBytes,
      0,
      1_099_511_627_776
    ),
    uploadAllowedMimeTypes: parseMimeTypes(get('uploadAllowedMimeTypes')),
    uploadRequireRightsConfirmation: bool('uploadRequireRightsConfirmation', SETTING_DEFAULTS.uploadRequireRightsConfirmation),
    autoPublishUploads: bool('autoPublishUploads', SETTING_DEFAULTS.autoPublishUploads),
    storageMigrationMaxBytes: clampNumber(
      get('storageMigrationMaxBytes'),
      SETTING_DEFAULTS.storageMigrationMaxBytes,
      1_048_576,
      209_715_200
    ),
    streamUrlTtlSeconds: clampNumber(get('streamUrlTtlSeconds'), SETTING_DEFAULTS.streamUrlTtlSeconds, 30, 86_400),
    maxPlaylistsPerUser: clampNumber(get('maxPlaylistsPerUser'), SETTING_DEFAULTS.maxPlaylistsPerUser, 0, 10_000),
    maxTracksPerPlaylist: clampNumber(get('maxTracksPerPlaylist'), SETTING_DEFAULTS.maxTracksPerPlaylist, 1, 10_000),
  };
}

let settingsCache: { value: Settings; expiresAt: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 15_000;

/** Drop the per-isolate settings cache (called after an admin update). */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/**
 * Settings are read on almost every request, so they are memoised per isolate for
 * 15 seconds. Writes invalidate immediately; a stale value can only ever be a
 * conservative business limit, never an authentication decision.
 */
export async function loadSettingsCached(db: D1Database): Promise<Settings> {
  if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;
  const value = await loadSettings(db);
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  return value;
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  try {
    const result = await db.prepare('SELECT key, value FROM app_settings').all<{ key: string; value: string }>();
    return settingsFromRows(result.results ?? []);
  } catch {
    // A missing settings table (migrations not applied) must not break read-only
    // endpoints; defaults are safe and upload limits are conservative.
    return { ...SETTING_DEFAULTS };
  }
}

export function serialiseSettingValue(key: keyof Settings, value: unknown): string {
  if (key === 'uploadAllowedMimeTypes') {
    if (!Array.isArray(value)) throw new Error('uploadAllowedMimeTypes must be an array');
    return JSON.stringify(value.map((entry) => String(entry).toLowerCase()));
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string') return value;
  throw new Error(`Unsupported value for setting ${key}`);
}
