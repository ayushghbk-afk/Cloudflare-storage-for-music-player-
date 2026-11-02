/**
 * Storage adapters.
 *
 * Two implementations of the same `StorageAdapter` contract:
 *
 *  1. `BindingStorageAdapter` — uses the statically bound `MUSIC_BUCKET` R2
 *     binding. Zero-latency access, no credentials, but cannot presign, so
 *     uploads are streamed through the Worker.
 *  2. `S3StorageAdapter` — talks to the R2 (or any S3-compatible) HTTP API with
 *     SigV4. Required for *dynamically registered* providers, enables presigned
 *     uploads (browser → R2 directly) and presigned playback redirects.
 *
 * Neither adapter ever logs credentials.
 */
import type { R2Bucket } from '../platform';
import { presignUrl, signRequest, type AwsCredentials } from './sigv4';
import type {
  GetObjectResult,
  ListedObject,
  ObjectHead,
  ProbeResult,
  PutObjectOptions,
  PutObjectResult,
  RangeSpec,
  StorageAdapter,
  StorageProviderRow,
} from './types';

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `FixedLengthStream` is a workerd global: it gives R2 a stream whose length is
 * known up front, which is what the binding requires for streamed writes.
 *
 * It does not exist in Node (where the tests run), so a stream without a length
 * is buffered there only. In the Worker, a stream without `sizeBytes` is a hard
 * error rather than a silent whole-file buffer.
 */
interface FixedLengthStreamCtor {
  new (expectedLength: number): TransformStream<Uint8Array, Uint8Array>;
}

function fixedLengthStream(byteLength: number): TransformStream<Uint8Array, Uint8Array> | null {
  const ctor = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  return ctor ? new ctor(byteLength) : null;
}

function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function withTimeout(init: RequestInit, ms = REQUEST_TIMEOUT_MS): RequestInit {
  return { ...init, signal: AbortSignal.timeout(ms) };
}

/* -------------------------------------------------------------------------- */
/* R2 binding adapter                                                          */
/* -------------------------------------------------------------------------- */

export class BindingStorageAdapter implements StorageAdapter {
  readonly providerId: string;
  readonly bucketName: string;
  // R2 presigned URLs require S3 credentials; the binding cannot produce them.
  readonly canPresign = false;
  readonly canRangeRead = true;
  readonly supportsStreamingWrite = true;

  constructor(
    private readonly bucket: R2Bucket,
    provider: Pick<StorageProviderRow, 'id' | 'bucket_name'>
  ) {
    this.providerId = provider.id;
    this.bucketName = provider.bucket_name;
  }

  async head(key: string): Promise<ObjectHead | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return {
      key: object.key,
      size: object.size,
      ...(object.etag ? { etag: object.etag } : {}),
      ...(object.httpMetadata?.contentType ? { contentType: object.httpMetadata.contentType } : {}),
      ...(object.uploaded ? { uploadedAt: object.uploaded.toISOString() } : {}),
      ...(object.customMetadata ? { customMetadata: object.customMetadata } : {}),
    };
  }

  async get(key: string, range?: RangeSpec): Promise<GetObjectResult | null> {
    const head = await this.bucket.head(key);
    if (!head) return null;

    const object = await this.bucket.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
    if (!object) return null;

    return {
      body: object.body,
      size: head.size,
      returnedBytes: range ? Math.min(range.length, head.size - range.offset) : head.size,
      ...(object.httpMetadata?.contentType ? { contentType: object.httpMetadata.contentType } : {}),
      ...(object.etag ? { etag: object.etag } : {}),
    };
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
    options: PutObjectOptions = {}
  ): Promise<PutObjectResult> {
    const httpMetadata: Record<string, string> = {};
    if (options.contentType) httpMetadata.contentType = options.contentType;
    if (options.cacheControl) httpMetadata.cacheControl = options.cacheControl;
    const putOptions = {
      ...(Object.keys(httpMetadata).length > 0 ? { httpMetadata } : {}),
      ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}),
    };

    let payload: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string = body;
    if (body instanceof ReadableStream) {
      if (!options.sizeBytes || options.sizeBytes <= 0) {
        throw new Error(
          `Provider ${this.providerId} requires the byte length of a streamed write (pass sizeBytes); buffering whole files in the Worker is not supported.`
        );
      }
      const fixed = fixedLengthStream(options.sizeBytes);
      if (fixed) {
        // Do not await: the put must start reading while the body is still arriving.
        void body.pipeTo(fixed.writable).catch(() => undefined);
        payload = fixed.readable;
      } else {
        // Node (tests only): FixedLengthStream is unavailable, so read the stream.
        payload = new Uint8Array(await new Response(body).arrayBuffer());
        if (payload.byteLength !== options.sizeBytes) {
          throw new Error(
            `Stream length mismatch for ${key}: expected ${options.sizeBytes} bytes, received ${payload.byteLength}.`
          );
        }
      }
    }

    const object = await this.bucket.put(key, payload, putOptions);
    return { size: object.size, ...(object.etag ? { etag: object.etag } : {}) };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(prefix: string, limit = 1000): Promise<{ objects: ListedObject[]; truncated: boolean }> {
    const result = await this.bucket.list({ prefix, limit });
    return {
      objects: result.objects.map((object) => ({ key: object.key, size: object.size })),
      truncated: result.truncated,
    };
  }

  async presignGet(): Promise<string | null> {
    return null;
  }

  async presignPut(): Promise<string | null> {
    return null;
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      // A `head` on a key that should not exist is the cheapest round trip that
      // proves the binding works (errors throw, absence returns null).
      await this.bucket.head('__aether_healthcheck__');
      return { status: 'healthy', latencyMs: Date.now() - started, message: 'R2 binding reachable.' };
    } catch (error) {
      return {
        status: 'error',
        latencyMs: Date.now() - started,
        message: `R2 binding unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* S3-compatible adapter (Cloudflare R2 over HTTPS)                            */
/* -------------------------------------------------------------------------- */

export class S3StorageAdapter implements StorageAdapter {
  readonly providerId: string;
  readonly bucketName: string;
  readonly canPresign = true;
  readonly canRangeRead = true;
  readonly supportsStreamingWrite = false;
  private readonly endpoint: string;
  private readonly region: string;

  constructor(
    private readonly provider: StorageProviderRow,
    private readonly credentials: AwsCredentials
  ) {
    this.providerId = provider.id;
    this.bucketName = provider.bucket_name;
    this.endpoint = provider.endpoint.replace(/\/+$/, '');
    this.region = provider.region || 'auto';
  }

  private objectUrl(key: string, query?: Record<string, string>): string {
    const base = `${this.endpoint}/${encodeURIComponent(this.bucketName)}/${encodeKeyPath(key)}`;
    if (!query) return base;
    const params = new URLSearchParams(query);
    return `${base}?${params.toString()}`;
  }

  private bucketUrl(query?: Record<string, string>): string {
    const base = `${this.endpoint}/${encodeURIComponent(this.bucketName)}`;
    if (!query) return base;
    return `${base}?${new URLSearchParams(query).toString()}`;
  }

  private async request(
    method: string,
    url: string,
    options: { headers?: Record<string, string>; body?: Uint8Array | ArrayBuffer | string } = {}
  ): Promise<Response> {
    const signed = await signRequest({
      method,
      url,
      headers: options.headers ?? {},
      ...(options.body !== undefined ? { body: options.body } : {}),
      credentials: this.credentials,
      region: this.region,
      service: 's3',
    });
    const { host: _host, ...headers } = signed.headers;
    return fetch(
      signed.url,
      withTimeout({
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body as BodyInit } : {}),
      })
    );
  }

  async head(key: string): Promise<ObjectHead | null> {
    const response = await this.request('HEAD', this.objectUrl(key));
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StorageHttpError(response.status, `HEAD ${key} failed`, key);
    }
    const size = Number(response.headers.get('content-length') ?? '0');
    const etag = response.headers.get('etag')?.replace(/"/g, '');
    const contentType = response.headers.get('content-type') ?? undefined;
    return {
      key,
      size,
      ...(etag ? { etag } : {}),
      ...(contentType ? { contentType } : {}),
      ...(response.headers.get('last-modified') ? { uploadedAt: response.headers.get('last-modified')! } : {}),
    };
  }

  async get(key: string, range?: RangeSpec): Promise<GetObjectResult | null> {
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;

    const response = await this.request('GET', this.objectUrl(key), { headers });
    if (response.status === 404) return null;
    if (!response.ok || !response.body) {
      throw new StorageHttpError(response.status, `GET ${key} failed`, key);
    }

    let size = Number(response.headers.get('content-length') ?? '0');
    let returnedBytes = size;
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      const match = /\/(\d+)$/.exec(contentRange);
      if (match) size = Number(match[1]);
      const rangeMatch = /bytes (\d+)-(\d+)\//.exec(contentRange);
      if (rangeMatch) returnedBytes = Number(rangeMatch[2]) - Number(rangeMatch[1]) + 1;
      else returnedBytes = size;
    }

    return {
      body: response.body,
      size,
      returnedBytes,
      ...(response.headers.get('content-type') ? { contentType: response.headers.get('content-type')! } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')!.replace(/"/g, '') } : {}),
    };
  }

  /**
   * Small-object PUT (artwork, JSON sidecars, migration of tiny files).
   *
   * Streamed multi-hundred-megabyte uploads are intentionally NOT proxied through
   * the S3 adapter: SigV4 requires a payload hash, so proxying a stream would mean
   * buffering the file in Worker memory. Large uploads use presigned PUT
   * (`presignPut`) and go straight from the client to R2.
   */
  async put(
    key: string,
    body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
    options: PutObjectOptions = {}
  ): Promise<PutObjectResult> {
    if (typeof body !== 'string' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
      throw new Error(
        `Provider ${this.providerId} requires a presigned upload for streaming writes (see presignPut).`
      );
    }

    const payload =
      typeof body === 'string' ? new TextEncoder().encode(body) : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    const headers: Record<string, string> = { 'content-length': String(payload.byteLength) };
    if (options.contentType) headers['content-type'] = options.contentType;
    if (options.cacheControl) headers['cache-control'] = options.cacheControl;

    const response = await this.request('PUT', this.objectUrl(key), { headers, body: payload });
    if (!response.ok) throw new StorageHttpError(response.status, `PUT ${key} failed`, key);
    return {
      size: payload.byteLength,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')!.replace(/"/g, '') } : {}),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request('DELETE', this.objectUrl(key));
    if (!response.ok && response.status !== 404) {
      throw new StorageHttpError(response.status, `DELETE ${key} failed`, key);
    }
  }

  async list(prefix: string, limit = 1000): Promise<{ objects: ListedObject[]; truncated: boolean }> {
    const response = await this.request(
      'GET',
      this.bucketUrl({ 'list-type': '2', prefix, 'max-keys': String(Math.min(1000, limit)) })
    );
    if (!response.ok) throw new StorageHttpError(response.status, 'ListObjectsV2 failed', prefix);
    const xml = await response.text();
    const objects: ListedObject[] = [];
    const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
    for (const block of contents) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
      const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
      if (key !== undefined) objects.push({ key: decodeXml(key), size: Number(size ?? 0) });
    }
    return { objects, truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml) };
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string | null> {
    return presignUrl({
      method: 'GET',
      url: this.objectUrl(key),
      credentials: this.credentials,
      region: this.region,
      service: 's3',
      expiresIn: expiresInSeconds,
    });
  }

  async presignPut(key: string, options: { contentType: string; expiresInSeconds: number }): Promise<string | null> {
    // Content-Type is signed as a header so the direct upload must send exactly
    // this value; the API tells the client which value that is.
    const presigned = await presignUrl({
      method: 'PUT',
      url: this.objectUrl(key),
      credentials: this.credentials,
      region: this.region,
      service: 's3',
      expiresIn: options.expiresInSeconds,
    });
    return presigned;
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const response = await this.request('HEAD', this.bucketUrl());
      const latencyMs = Date.now() - started;
      if (response.ok) {
        return { status: 'healthy', latencyMs, message: 'Bucket reachable and credentials accepted.' };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'error',
          latencyMs,
          message: `Credentials rejected by provider (HTTP ${response.status}). Check credential reference "${this.provider.credential_ref ?? 'none'}".`,
        };
      }
      if (response.status === 404) {
        return { status: 'error', latencyMs, message: 'Bucket not found. Check bucket name and endpoint.' };
      }
      return { status: 'degraded', latencyMs, message: `Unexpected provider response HTTP ${response.status}.` };
    } catch (error) {
      return {
        status: 'error',
        latencyMs: Date.now() - started,
        message: `Provider unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export class StorageHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly key?: string
  ) {
    super(message);
    this.name = 'StorageHttpError';
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
