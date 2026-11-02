/**
 * AWS Signature Version 4 — request signing and query presigning.
 *
 * Why hand-written: R2's S3 API is only reachable through `fetch`, and presigned
 * URLs must be generated inside the Worker (Workers cannot use the AWS SDK).
 * The implementation is a direct transcription of the AWS/R2 signing rules and is
 * cross-checked against the reference `aws4` implementation in
 * `tests/worker/sigv4.test.ts`.
 */
import { sha256Hex } from '../utils/hash';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigningContext {
  region: string;
  service: string;
  /** Overridable clock for deterministic tests. */
  date?: Date;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** RFC 3986 encoding as required by SigV4 (`encodeURIComponent` leaves !*'() bare). */
export function uriEncode(value: string, encodeSlash = true): string {
  let encoded = encodeURIComponent(value);
  encoded = encoded.replace(/[!*'()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  if (!encodeSlash) encoded = encoded.replace(/%2F/gi, '/');
  return encoded;
}

export function toAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalQueryString(params: Iterable<[string, string]>): string {
  const entries = Array.from(params).map(([key, value]) => [uriEncode(key), uriEncode(value)] as [string, string]);
  entries.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return entries.map(([key, value]) => `${key}=${value}`).join('&');
}

function canonicalUri(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment), true))
    .join('/');
}

function canonicalHeaders(headers: Iterable<[string, string]>): { canonical: string; signedHeaders: string } {
  const normalised = new Map<string, string>();
  for (const [rawName, rawValue] of headers) {
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const value = rawValue.trim().replace(/\s+/g, ' ');
    normalised.set(name, normalised.has(name) ? `${normalised.get(name)},${value}` : value);
  }
  const sorted = Array.from(normalised.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonical = sorted.map(([name, value]) => `${name}:${value}\n`).join('');
  return { canonical, signedHeaders: sorted.map(([name]) => name).join(';') };
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

async function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  let key = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  return hmac(key, 'aws4_request');
}

function scopeString(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/aws4_request`;
}

/**
 * Generate a presigned URL (query-string authentication).
 *
 * `expiresIn` is clamped to the S3/R2 maximum of 7 days.
 */
export async function presignUrl(options: {
  method: string;
  url: string;
  credentials: AwsCredentials;
  region: string;
  service: string;
  expiresIn: number;
  date?: Date;
}): Promise<string> {
  const url = new URL(options.url);
  const date = options.date ?? new Date();
  const { amzDate, dateStamp } = toAmzDate(date);
  const expiresIn = Math.min(604_800, Math.max(1, Math.trunc(options.expiresIn)));
  const scope = scopeString(dateStamp, options.region, options.service);

  const params: [string, string][] = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${options.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (options.credentials.sessionToken) params.push(['X-Amz-Security-Token', options.credentials.sessionToken]);
  for (const [key, value] of url.searchParams) params.push([key, value]);

  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(params),
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = await signingKey(options.credentials.secretAccessKey, dateStamp, options.region, options.service);
  const signature = Array.from(await hmac(key, stringToSign), (byte) => byte.toString(16).padStart(2, '0')).join('');

  return `${url.origin}${url.pathname}?${canonicalQueryString(params)}&X-Amz-Signature=${signature}`;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Sign a normal (header-based) request. The returned headers deliberately omit
 * `host` and `content-length`: the runtime sets both, and they are already part
 * of the signature.
 */
export async function signRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | ArrayBuffer | string;
  credentials: AwsCredentials;
  region: string;
  service: string;
  date?: Date;
}): Promise<SignedRequest> {
  const url = new URL(options.url);
  const date = options.date ?? new Date();
  const { amzDate, dateStamp } = toAmzDate(date);
  const scope = scopeString(dateStamp, options.region, options.service);

  const payloadHash =
    options.body === undefined
      ? sha256Hex('')
      : typeof options.body === 'string'
        ? sha256Hex(options.body)
        : sha256Hex(options.body);

  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name.toLowerCase(), value);
  }
  headers.set('host', url.host);
  headers.set('x-amz-date', amzDate);
  headers.set('x-amz-content-sha256', payloadHash);
  if (options.credentials.sessionToken) headers.set('x-amz-security-token', options.credentials.sessionToken);

  const { canonical, signedHeaders } = canonicalHeaders(headers);
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonical,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = await signingKey(options.credentials.secretAccessKey, dateStamp, options.region, options.service);
  const signature = Array.from(await hmac(key, stringToSign), (byte) => byte.toString(16).padStart(2, '0')).join('');

  const outHeaders: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (name === 'host') continue;
    outHeaders[name] = value;
  }
  outHeaders['authorization'] =
    `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: url.toString(), headers: outHeaders };
}

export { canonicalQueryString, canonicalUri, canonicalHeaders, signingKey, scopeString };
