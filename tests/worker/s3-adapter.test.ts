import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3StorageAdapter } from '../../worker/src/storage/r2';
import type { StorageProviderRow } from '../../worker/src/storage/types';

function provider(overrides: Partial<StorageProviderRow> = {}): StorageProviderRow {
  return {
    id: 'prv_remote',
    name: 'remote',
    kind: 'r2',
    account_id: 'abcdef0123456789',
    bucket_name: 'aether-music',
    endpoint: 'https://abcdef0123456789.r2.cloudflarestorage.com',
    region: 'auto',
    auth_mode: 'credentials',
    credential_ref: 'remote',
    priority: 10,
    enabled: 1,
    capacity_bytes: null,
    health_status: 'unknown',
    health_checked_at: null,
    health_latency_ms: null,
    health_message: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const credentials = {
  accessKeyId: 'AKIAEXAMPLEKEY0000001',
  secretAccessKey: 'example-secret-key-value-0000000000000001',
};

let fetchMock: ReturnType<typeof vi.fn>;
let adapter: S3StorageAdapter;

function respond(body: BodyInit | null, init: ResponseInit = { status: 200 }): void {
  fetchMock.mockResolvedValueOnce(new Response(body, init));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  adapter = new S3StorageAdapter(provider(), credentials);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

describe('capabilities', () => {
  it('advertises presigning and range reads but not streaming writes', () => {
    expect(adapter.canPresign).toBe(true);
    expect(adapter.canRangeRead).toBe(true);
    expect(adapter.supportsStreamingWrite).toBe(false);
    expect(adapter.providerId).toBe('prv_remote');
    expect(adapter.bucketName).toBe('aether-music');
  });
});

describe('head', () => {
  it('returns size, etag and content type', async () => {
    respond(null, {
      status: 200,
      headers: { 'content-length': '1024', etag: '"abc123"', 'content-type': 'audio/mpeg', 'last-modified': 'Mon, 05 Oct 2026 10:00:00 GMT' },
    });

    const head = await adapter.head('audio/song.mp3');
    expect(head).toEqual({
      key: 'audio/song.mp3',
      size: 1024,
      etag: 'abc123',
      contentType: 'audio/mpeg',
      uploadedAt: 'Mon, 05 Oct 2026 10:00:00 GMT',
    });

    const { url, init } = lastCall();
    expect(url).toBe('https://abcdef0123456789.r2.cloudflarestorage.com/aether-music/audio/song.mp3');
    expect(init.method).toBe('HEAD');
  });

  it('returns null for a missing key and throws for other failures', async () => {
    respond(null, { status: 404 });
    expect(await adapter.head('audio/missing.mp3')).toBeNull();

    respond(null, { status: 500 });
    await expect(adapter.head('audio/broken.mp3')).rejects.toThrow(/HEAD audio\/broken\.mp3 failed/);
  });

  it('signs reserved characters inside keys but keeps path separators', async () => {
    respond(null, { status: 200 });
    await adapter.head('audio/Drum & Bass/100% Pure.mp3');
    const { url } = lastCall();
    expect(url).toContain('/audio/Drum%20%26%20Bass/100%25%20Pure.mp3');
    expect(url).not.toContain('%2F');
  });
});

describe('get', () => {
  it('sends a byte range and reports both slice and total size', async () => {
    respond('0123456789', {
      status: 206,
      headers: { 'content-length': '4', 'content-range': 'bytes 2-5/1000', 'content-type': 'audio/mpeg' },
    });

    const result = await adapter.get('audio/song.mp3', { offset: 2, length: 4 });
    expect(result).not.toBeNull();
    expect(result!.returnedBytes).toBe(4);
    expect(result!.size).toBe(1000);
    expect(result!.contentType).toBe('audio/mpeg');

    const { init } = lastCall();
    expect((init.headers as Record<string, string>).range).toBe('bytes=2-5');
  });

  it('omits the range header for a full read', async () => {
    respond('bytes', { status: 200, headers: { 'content-length': '5' } });
    const result = await adapter.get('audio/song.mp3');
    expect(result!.returnedBytes).toBe(5);
    expect(result!.size).toBe(5);
    expect((lastCall().init.headers as Record<string, string>).range).toBeUndefined();
  });

  it('returns null on 404 and throws on 5xx', async () => {
    respond(null, { status: 404 });
    expect(await adapter.get('audio/gone.mp3')).toBeNull();

    respond('boom', { status: 503 });
    await expect(adapter.get('audio/angry.mp3')).rejects.toThrow(/GET audio\/angry\.mp3 failed/);
  });

  it('authenticates with SigV4 header signing', async () => {
    respond('x', { status: 200, headers: { 'content-length': '1' } });
    await adapter.get('audio/song.mp3');
    const { init, url } = lastCall();
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY0000001\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=/);
    expect(headers['x-amz-content-sha256']).toBeTruthy();
    expect(url).not.toContain('X-Amz-Signature');
  });
});

describe('put', () => {
  it('uploads a small buffer with a signed payload hash', async () => {
    respond(null, { status: 200, headers: { etag: '"newetag"' } });
    const bytes = new TextEncoder().encode('cover-art');
    const result = await adapter.put('artwork/cover.png', bytes, { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' });

    expect(result.size).toBe(bytes.byteLength);
    expect(result.etag).toBe('newetag');

    const { init } = lastCall();
    const headers = init.headers as Record<string, string>;
    expect(headers['content-length']).toBe(String(bytes.byteLength));
    expect(headers['content-type']).toBe('image/png');
    expect(headers['cache-control']).toContain('immutable');
    expect(headers['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
  });

  it('refuses streamed writes instead of buffering them into memory', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    await expect(adapter.put('audio/big.flac', stream)).rejects.toThrow(/presigned upload/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a rejected upload', async () => {
    respond('denied', { status: 403 });
    await expect(adapter.put('artwork/x.png', new Uint8Array([1]), { contentType: 'image/png' })).rejects.toThrow(/PUT artwork\/x\.png failed/);
  });
});

describe('delete and list', () => {
  it('treats 404 as already deleted', async () => {
    respond(null, { status: 204 });
    await expect(adapter.delete('audio/song.mp3')).resolves.toBeUndefined();

    respond(null, { status: 404 });
    await expect(adapter.delete('audio/song.mp3')).resolves.toBeUndefined();

    respond(null, { status: 500 });
    await expect(adapter.delete('audio/song.mp3')).rejects.toThrow(/DELETE/);
  });

  it('parses a ListObjectsV2 response and decodes escaped keys', async () => {
    respond(
      `<?xml version="1.0"?><ListBucketResult>
         <IsTruncated>false</IsTruncated>
         <Contents><Key>audio/a.mp3</Key><Size>11</Size></Contents>
         <Contents><Key>audio/Drum &amp; Bass/b.flac</Key><Size>22</Size></Contents>
       </ListBucketResult>`,
      { status: 200, headers: { 'content-type': 'application/xml' } }
    );

    const listed = await adapter.list('audio/', 500);
    expect(listed.objects).toEqual([
      { key: 'audio/a.mp3', size: 11 },
      { key: 'audio/Drum & Bass/b.flac', size: 22 },
    ]);
    expect(listed.truncated).toBe(false);

    const { url } = lastCall();
    expect(url).toContain('list-type=2');
    expect(url).toContain('prefix=audio%2F');
    expect(url).toContain('max-keys=500');
  });

  it('reports truncation', async () => {
    respond('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>', { status: 200 });
    expect((await adapter.list('audio/')).truncated).toBe(true);
  });
});

describe('presigning', () => {
  it('builds a presigned GET URL with the expected query parameters', async () => {
    const url = await adapter.presignGet('audio/song.mp3', 900);
    expect(url).toBeTruthy();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAEXAMPLEKEY0000001\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    // Presigning is local: no network call is made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps an excessive expiry to the SigV4 maximum', async () => {
    const url = await adapter.presignGet('audio/song.mp3', 999_999);
    expect(new URL(url!).searchParams.get('X-Amz-Expires')).toBe('604800');
  });

  it('presigns a PUT without leaking the secret into the URL', async () => {
    const url = await adapter.presignPut('audio/new.mp3', { contentType: 'audio/mpeg', expiresInSeconds: 600 });
    expect(url).toBeTruthy();
    expect(url!).not.toContain(credentials.secretAccessKey);
    expect(new URL(url!).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('probe', () => {
  it('reports healthy on a 200 bucket HEAD', async () => {
    respond(null, { status: 200 });
    const result = await adapter.probe();
    expect(result.status).toBe('healthy');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(lastCall().url).toBe('https://abcdef0123456789.r2.cloudflarestorage.com/aether-music');
  });

  it('explains rejected credentials without printing them', async () => {
    respond(null, { status: 403 });
    const result = await adapter.probe();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/Credentials rejected/);
    expect(result.message).toContain('remote');
    expect(result.message).not.toContain(credentials.secretAccessKey);
  });

  it('distinguishes a missing bucket', async () => {
    respond(null, { status: 404 });
    expect((await adapter.probe()).message).toMatch(/Bucket not found/);
  });

  it('reports an unreachable endpoint as an error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    const result = await adapter.probe();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/unreachable/);
  });
});

describe('binding adapter streamed writes', () => {
  it('refuses a stream without a declared length instead of buffering it', async () => {
    const { BindingStorageAdapter } = await import('../../worker/src/storage/r2');
    const { MemoryBucket } = await import('../support/storage');
    const bucket = new MemoryBucket();
    const binding = new BindingStorageAdapter(bucket, provider({ auth_mode: 'binding', credential_ref: null }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    await expect(binding.put('audio/x.mp3', stream, { contentType: 'audio/mpeg' })).rejects.toThrow(/byte length/);
    expect(bucket.objects.size).toBe(0);
  });

  it('stores a declared-length stream and reports the size', async () => {
    const { BindingStorageAdapter } = await import('../../worker/src/storage/r2');
    const { MemoryBucket } = await import('../support/storage');
    const bucket = new MemoryBucket();
    const binding = new BindingStorageAdapter(bucket, provider({ auth_mode: 'binding', credential_ref: null }));
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        controller.enqueue(bytes.subarray(4));
        controller.close();
      },
    });

    const result = await binding.put('audio/y.mp3', stream, { contentType: 'audio/mpeg', sizeBytes: 8 });
    expect(result.size).toBe(8);
    expect(bucket.objects.get('audio/y.mp3')?.bytes).toEqual(bytes);
  });

  it('detects a stream shorter than the declared length', async () => {
    const { BindingStorageAdapter } = await import('../../worker/src/storage/r2');
    const { MemoryBucket } = await import('../support/storage');
    const bucket = new MemoryBucket();
    const binding = new BindingStorageAdapter(bucket, provider({ auth_mode: 'binding', credential_ref: null }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    await expect(binding.put('audio/z.mp3', stream, { contentType: 'audio/mpeg', sizeBytes: 8 })).rejects.toThrow(/length mismatch/);
    expect(bucket.objects.size).toBe(0);
  });
});
