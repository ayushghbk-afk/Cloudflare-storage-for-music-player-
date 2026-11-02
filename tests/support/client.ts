import type { TestContext } from './env';

export interface ApiOptions {
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  token?: string;
  headers?: Record<string, string>;
  /**
   * `CF-Connecting-IP`. Tests get a fresh address per request by default so that
   * per-IP rate limits do not leak between unrelated assertions; tests that
   * deliberately exercise rate limiting pass a fixed value.
   */
  ip?: string;
}

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}.${1 + (ipCounter % 200)}`;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

/** Perform a request against the app with the test environment bound. */
export async function request(ctx: TestContext, path: string, options: ApiOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  headers['cf-connecting-ip'] = options.ip ?? nextIp();
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  let body: BodyInit | undefined = options.rawBody;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const method = options.method ?? (body !== undefined ? 'POST' : 'GET');
  return ctx.app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) }, ctx.env);
}

export async function api<T = unknown>(ctx: TestContext, path: string, options: ApiOptions = {}): Promise<ApiResponse<T>> {
  const response = await request(ctx, path, options);
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, headers: response.headers, body: parsed as T, text };
}

export const DEFAULT_PASSWORD = 'Aether-Beacon-9271';

let sequence = 0;

export interface AuthResult {
  token: string;
  refreshToken: string;
  user: { id: string; email: string; displayName: string; role: string };
  response: ApiResponse;
}

export async function registerUser(
  ctx: TestContext,
  options: { email?: string; password?: string; displayName?: string } = {}
): Promise<AuthResult> {
  sequence += 1;
  const email = options.email ?? `user${sequence}.${Date.now()}@example.test`;
  const password = options.password ?? DEFAULT_PASSWORD;
  const displayName = options.displayName ?? `User ${sequence}`;

  const response = await api<Record<string, unknown>>(ctx, '/api/auth/register', {
    body: { email, password, displayName },
  });

  if (response.status !== 201) {
    throw new Error(`register failed (${response.status}): ${response.text}`);
  }

  const body = response.body as { accessToken: string; refreshToken: string; user: AuthResult['user'] };
  return { token: body.accessToken, refreshToken: body.refreshToken, user: body.user, response };
}

/** Promote a user by direct SQL (test-only shortcut for staff-only endpoints). */
export async function promote(ctx: TestContext, userId: string, role: 'moderator' | 'admin'): Promise<void> {
  await ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, userId).run();
}

export async function registerAdmin(ctx: TestContext): Promise<AuthResult> {
  const admin = await registerUser(ctx, { email: 'admin@example.test', displayName: 'Admin' });
  await promote(ctx, admin.user.id, 'admin');
  return admin;
}

export interface UploadResult {
  jobId: string;
  trackId: string;
  status: string;
  body: Record<string, unknown>;
  initBody: Record<string, unknown>;
}

/**
 * Runs the full upload flow the way a client does:
 * init -> PUT bytes -> complete.
 */
export async function uploadTrack(
  ctx: TestContext,
  token: string,
  bytes: Uint8Array,
  options: {
    filename?: string;
    mimeType?: string;
    rightsConfirmed?: boolean;
    metadata?: Record<string, unknown>;
    mode?: 'direct' | 'worker';
  } = {}
): Promise<UploadResult> {
  const filename = options.filename ?? 'song.mp3';
  const mimeType = options.mimeType ?? 'audio/mpeg';

  const init = await api<Record<string, unknown>>(ctx, '/api/upload/init', {
    token,
    body: {
      filename,
      size: bytes.byteLength,
      mimeType,
      rightsConfirmed: options.rightsConfirmed ?? true,
      ...(options.metadata ?? {}),
    },
  });
  if (init.status !== 201) {
    throw new Error(`upload init failed (${init.status}): ${init.text}`);
  }

  const jobId = String(init.body.jobId);
  const uploadUrl = String(init.body.uploadUrl);
  const mode = String(init.body.uploadMode);
  if (options.mode && mode !== options.mode) {
    throw new Error(`expected upload mode ${options.mode} but the API chose ${mode}`);
  }

  const path = new URL(uploadUrl, 'http://localhost').pathname + new URL(uploadUrl, 'http://localhost').search;
  const putResponse = await request(ctx, path, {
    method: 'PUT',
    token,
    rawBody: bytes as unknown as BodyInit,
    headers: { 'content-type': mimeType, 'content-length': String(bytes.byteLength) },
  });
  if (putResponse.status !== 200) {
    throw new Error(`upload put failed (${putResponse.status}): ${await putResponse.text()}`);
  }

  const complete = await api<Record<string, unknown>>(ctx, `/api/upload/complete?jobId=${jobId}`, {
    token,
    body: {},
  });
  if (complete.status !== 201 && complete.status !== 200) {
    throw new Error(`upload complete failed (${complete.status}): ${complete.text}`);
  }

  return {
    jobId,
    trackId: String(complete.body.trackId ?? ''),
    status: String(complete.body.status ?? ''),
    body: complete.body,
    initBody: init.body,
  };
}

export async function approveTrack(ctx: TestContext, adminToken: string, trackId: string): Promise<ApiResponse> {
  return api(ctx, `/api/admin/tracks/${trackId}/approve`, { token: adminToken, method: 'POST', body: {} });
}

/** Convenience: upload + approve, returning a public track id. */
export async function publishTrack(
  ctx: TestContext,
  uploaderToken: string,
  adminToken: string,
  bytes: Uint8Array,
  options: Parameters<typeof uploadTrack>[3] = {}
): Promise<string> {
  const uploaded = await uploadTrack(ctx, uploaderToken, bytes, options);
  const approved = await approveTrack(ctx, adminToken, uploaded.trackId);
  if (approved.status !== 200) {
    throw new Error(`approve failed (${approved.status}): ${approved.text}`);
  }
  return uploaded.trackId;
}
