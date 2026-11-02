/**
 * Typed API client for the AETHER admin console.
 *
 * Security notes:
 *  * Tokens are kept in `sessionStorage`, not `localStorage`, so they disappear
 *    when the tab closes. The console is an internal tool; a production
 *    deployment should put it behind Cloudflare Access as well (docs/SECURITY.md).
 *  * No secret, access key or credential value is ever sent to the browser: the
 *    API only reports *names* of missing secrets.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

const ACCESS_TOKEN_KEY = 'aether.console.access';
const REFRESH_TOKEN_KEY = 'aether.console.refresh';

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
  fingerprint?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, shape: ApiErrorShape) {
    super(shape.message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = shape.code;
    if (shape.details !== undefined) this.details = shape.details;
    if (shape.requestId !== undefined) this.requestId = shape.requestId;
  }
}

export function getAccessToken(): string | null {
  return sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setTokens(tokens: { accessToken: string; refreshToken?: string } | null): void {
  if (!tokens) {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    return;
  }
  sessionStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
  if (tokens.refreshToken) sessionStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
}

function getRefreshToken(): string | null {
  return sessionStorage.getItem(REFRESH_TOKEN_KEY);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Internal: prevents an infinite refresh loop. */
  retried?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const url = `${BASE_URL}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(response: Response): Promise<ApiError> {
  let shape: ApiErrorShape = { code: `HTTP_${response.status}`, message: response.statusText || 'Request failed' };
  try {
    const body = (await response.json()) as { error?: ApiErrorShape };
    if (body?.error) shape = body.error;
  } catch {
    // Non-JSON error body (proxy, gateway): keep the status-derived message.
  }
  return new ApiError(response.status, shape);
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const response = await fetch(buildUrl('/api/auth/refresh', undefined), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
        if (!data.accessToken) return false;
        setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken ?? refreshToken });
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getAccessToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;

  const response = await fetch(buildUrl(path, options.query), init);

  if (response.status === 401 && !options.retried && getRefreshToken()) {
    const refreshed = await refreshSession();
    if (refreshed) return request<T>(path, { ...options, retried: true });
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Response types (mirroring worker/src)                                       */
/* -------------------------------------------------------------------------- */

export type Role = 'user' | 'moderator' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: string;
  createdAt?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
}

export interface Stats {
  totalTracks: number;
  publicTracks: number;
  pendingTracks: number;
  rejectedTracks: number;
  removedTracks: number;
  totalUsers: number;
  newUsers7d: number;
  activeUploads: number;
  pendingUploads: number;
  failedUploads: number;
  failedUploads7d: number;
  openReports: number;
  playbackErrors24h: number;
  plays24h: number;
  storageUsedBytes: number;
  storageObjectCount: number;
}

export interface ProviderSummary {
  id: string;
  name: string;
  bucketName: string;
  endpoint: string;
  enabled: boolean;
  priority: number;
  healthStatus: HealthStatus;
  healthCheckedAt: string | null;
  healthMessage: string | null;
  usedBytes: number;
  objectCount: number;
  capacityBytes: number | null;
}

export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'error' | 'unconfigured';

export interface StatsResponse {
  stats: Stats;
  storage: {
    providers: ProviderSummary[];
    healthy: number;
    degraded: number;
    errored: number;
    unconfigured: number;
    unknown: number;
  };
  recentFailures: { id: string; filename: string; errorCode: string | null; errorMessage: string | null; createdAt: string }[];
}

export interface CredentialStatus {
  available: boolean;
  mode: string;
  requiredSecrets: string[];
  missingSecrets: string[];
}

export interface StorageProvider {
  id: string;
  name: string;
  kind: 'r2' | 's3';
  accountId: string | null;
  bucketName: string;
  endpoint: string;
  region: string;
  authMode: 'credentials' | 'binding';
  credentialRef: string | null;
  priority: number;
  enabled: boolean;
  capacityBytes: number | null;
  notes: string | null;
  health: { status: HealthStatus; checkedAt: string | null; latencyMs: number | null; message: string | null };
  credentials: CredentialStatus;
  usage: { usedBytes: number; objectCount: number; capacityBytes: number | null; utilisation: number | null };
  createdAt: string;
  updatedAt: string;
}

export interface StorageListResponse {
  providers: StorageProvider[];
  summary: {
    providerCount: number;
    enabledCount: number;
    totalUsedBytes: number;
    objectCount: number;
    totalCapacityBytes: number | null;
    providersWithRecordedCapacity: number;
  };
  note: string;
}

export interface HealthReport {
  providerId: string;
  name: string;
  bucket: string;
  endpoint: string;
  enabled: boolean;
  priority: number;
  authMode: string;
  status: HealthStatus;
  latencyMs: number | null;
  message: string;
  checkedAt: string;
  credentials: CredentialStatus;
  usage: { objectCount: number; usedBytes: number; capacityBytes: number | null };
}

export interface AdminTrack {
  id: string;
  title: string;
  artist: { id: string; name: string } | null;
  album: { id: string; title: string; year: number | null } | null;
  uploader: { id: string; name: string | null } | null;
  status: string;
  visibility: string;
  format: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  rightsConfirmed: boolean;
  rejectionReason: string | null;
  reviewedAt: string | null;
  artworkUrl: string | null;
  streamUrl: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface AdminTrackList {
  tracks: AdminTrack[];
  pagination: { total: number; limit: number; offset: number };
}

export interface UploadRow {
  id: string;
  status: string;
  filename: string;
  declaredSizeBytes: number;
  uploadedSizeBytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  trackId: string | null;
  providerId: string | null;
  uploader: { email: string; name: string | null } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface UploadList {
  uploads: UploadRow[];
  pagination: { total: number; limit: number; offset: number };
}

export interface Report {
  id: string;
  trackId: string;
  trackTitle: string | null;
  trackStatus: string | null;
  trackVisibility: string | null;
  uploaderId: string | null;
  reporter: { id: string; name: string | null } | null;
  reason: string;
  details: string | null;
  status: string;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ReportList {
  reports: Report[];
  pagination: { total: number; limit: number; offset: number };
}

export interface AuditEntry {
  id: string;
  actor: { id: string; email: string | null } | null;
  action: string;
  target: { type: string | null; id: string } | null;
  metadata: unknown;
  ipHash: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AuditList {
  entries: AuditEntry[];
  pagination: { total: number; limit: number; offset: number };
}

export interface SettingsSchemaEntry {
  key: string;
  description: string;
  default: unknown;
  bounds: { min: number; max: number } | null;
  boolean: boolean;
  array: boolean;
}

export interface SettingsResponse {
  settings: Record<string, unknown>;
  schema: SettingsSchemaEntry[];
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  uploadQuotaBytes: number | null;
  trackCount: number;
}

export interface UserList {
  users: AdminUser[];
  pagination: { total: number; limit: number; offset: number };
}

export interface PlaybackError {
  id: string;
  trackId: string | null;
  trackTitle: string | null;
  platform: string | null;
  code: string | null;
  message: string | null;
  providerId: string | null;
  createdAt: string;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request<{ user: AuthUser }>('/api/auth/me'),
  logout: (refreshToken: string) => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: { refreshToken } }),

  stats: () => request<StatsResponse>('/api/admin/stats'),
  storage: () => request<StorageListResponse>('/api/admin/storage'),
  storageHealth: () => request<{ providers: HealthReport[]; checkedAt: string; note: string }>('/api/admin/storage/health'),
  checkProvider: (id: string) =>
    request<{ health: HealthReport }>(`/api/admin/storage/health/${id}/check`, { method: 'POST', body: {} }),
  createProvider: (body: Record<string, unknown>) =>
    request<{ provider: StorageProvider; health: HealthReport }>('/api/admin/storage/providers', { method: 'POST', body }),
  updateProvider: (id: string, body: Record<string, unknown>) =>
    request<{ provider: StorageProvider }>(`/api/admin/storage/providers/${id}`, { method: 'PATCH', body }),
  deleteProvider: (id: string) => request<{ ok: boolean }>(`/api/admin/storage/providers/${id}`, { method: 'DELETE' }),
  verifyTrack: (trackId: string) =>
    request<{ result: { ok: boolean; actualSha256: string; expectedSha256: string | null; checkedAt: string } }>(
      '/api/admin/storage/verify',
      { method: 'POST', body: { trackId } }
    ),
  migrateTrack: (trackId: string, targetProviderId: string, deleteSource: boolean) =>
    request<{ result: { fromProviderId: string; toProviderId: string; bytes: number; deletedSource: boolean } }>(
      '/api/admin/storage/migrate',
      { method: 'POST', body: { trackId, targetProviderId, deleteSource } }
    ),

  tracks: (query: { status?: string; q?: string; limit?: number; offset?: number }) =>
    request<AdminTrackList>('/api/admin/tracks', { query }),
  approveTrack: (id: string) => request<{ track: AdminTrack }>(`/api/admin/tracks/${id}/approve`, { method: 'POST', body: {} }),
  rejectTrack: (id: string, reason: string) =>
    request<{ track: AdminTrack }>(`/api/admin/tracks/${id}/reject`, { method: 'POST', body: { reason } }),
  removeTrack: (id: string, reason: string, deleteFiles: boolean) =>
    request<{ ok: boolean; filesDeleted: boolean; deletionFailures: unknown[] }>(`/api/admin/tracks/${id}/remove`, {
      method: 'POST',
      body: { reason, deleteFiles },
    }),

  reports: (query: { status?: string; limit?: number; offset?: number }) => request<ReportList>('/api/admin/reports', { query }),
  resolveReport: (id: string, body: { status: 'resolved' | 'dismissed'; note?: string; action?: 'none' | 'unpublish' | 'remove' }) =>
    request<{ ok: boolean; status: string; trackAction: string }>(`/api/admin/reports/${id}/resolve`, { method: 'POST', body }),

  audit: (query: { action?: string; actorId?: string; limit?: number; offset?: number }) =>
    request<AuditList>('/api/admin/audit', { query }),
  settings: () => request<SettingsResponse>('/api/admin/settings'),
  updateSettings: (body: Record<string, unknown>) => request<{ settings: Record<string, unknown> }>('/api/admin/settings', { method: 'PATCH', body }),
  users: (query: { q?: string; role?: string; limit?: number; offset?: number }) => request<UserList>('/api/admin/users', { query }),
  updateUser: (id: string, body: { role?: Role; status?: 'active' | 'suspended'; uploadQuotaBytes?: number | null }) =>
    request<{ ok: boolean; userId: string; role: string; status: string }>(`/api/admin/users/${id}`, { method: 'PATCH', body }),
  uploads: (query: { status?: string; limit?: number; offset?: number }) => request<UploadList>('/api/admin/uploads', { query }),
  playbackErrors: (query: { limit?: number; offset?: number }) =>
    request<{ errors: PlaybackError[]; pagination: { total: number } }>('/api/admin/playback-errors', { query }),
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'not recorded';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
