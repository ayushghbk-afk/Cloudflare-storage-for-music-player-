import { createHash } from 'node:crypto';
import type { KVNamespace, R2Bucket, R2GetOptions, R2ListOptions, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from '../../worker/src/platform';

interface StoredEntry {
  bytes: Uint8Array;
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
  uploaded: Date;
  etag: string;
}

async function toBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

/**
 * In-memory R2 bucket with the semantics the API relies on: byte ranges, ETags,
 * metadata, listing and deletion.
 */
export class MemoryBucket implements R2Bucket {
  readonly objects = new Map<string, StoredEntry>();
  /** When set, every operation throws — used to test provider failure handling. */
  failure: Error | null = null;
  calls: { operation: string; key?: string }[] = [];

  private guard(operation: string, key?: string): void {
    this.calls.push({ operation, ...(key ? { key } : {}) });
    if (this.failure) throw this.failure;
  }

  private meta(key: string, entry: StoredEntry): R2Object {
    return {
      key,
      size: entry.bytes.byteLength,
      etag: entry.etag,
      httpEtag: `"${entry.etag}"`,
      uploaded: entry.uploaded,
      ...(entry.contentType || entry.cacheControl ? { httpMetadata: { ...(entry.contentType ? { contentType: entry.contentType } : {}), ...(entry.cacheControl ? { cacheControl: entry.cacheControl } : {}) } } : {}),
      ...(entry.customMetadata ? { customMetadata: entry.customMetadata } : {}),
    };
  }

  async head(key: string): Promise<R2Object | null> {
    this.guard('head', key);
    const entry = this.objects.get(key);
    return entry ? this.meta(key, entry) : null;
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    this.guard('get', key);
    const entry = this.objects.get(key);
    if (!entry) return null;

    let bytes = entry.bytes;
    const range = options?.range;
    if (range) {
      if (range.suffix !== undefined) {
        bytes = bytes.subarray(Math.max(0, bytes.byteLength - range.suffix));
      } else {
        const offset = range.offset ?? 0;
        const length = range.length ?? bytes.byteLength - offset;
        bytes = bytes.subarray(offset, offset + length);
      }
    }

    const copy = bytes.slice();
    const meta = this.meta(key, entry);
    return {
      ...meta,
      size: entry.bytes.byteLength,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(copy);
          controller.close();
        },
      }),
      bodyUsed: false,
      arrayBuffer: async () => copy.slice().buffer as ArrayBuffer,
      text: async () => new TextDecoder().decode(copy),
      blob: async () => new Blob([copy as unknown as BlobPart]),
    };
  }

  async put(key: string, value: Parameters<R2Bucket['put']>[1], options?: R2PutOptions): Promise<R2Object> {
    this.guard('put', key);
    const bytes = await toBytes(value);
    const entry: StoredEntry = {
      bytes,
      uploaded: new Date(),
      etag: md5(bytes),
      ...(options?.httpMetadata?.contentType ? { contentType: options.httpMetadata.contentType } : {}),
      ...(options?.httpMetadata?.cacheControl ? { cacheControl: options.httpMetadata.cacheControl } : {}),
      ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
    };
    this.objects.set(key, entry);
    return this.meta(key, entry);
  }

  async delete(key: string | string[]): Promise<void> {
    this.guard('delete', Array.isArray(key) ? key.join(',') : key);
    for (const entry of Array.isArray(key) ? key : [key]) this.objects.delete(entry);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    this.guard('list');
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const page = keys.slice(0, limit);
    return {
      objects: page.map((key) => this.meta(key, this.objects.get(key)!)),
      truncated: keys.length > limit,
    };
  }

  /** Test helper: read raw bytes. */
  bytes(key: string): Uint8Array | null {
    return this.objects.get(key)?.bytes ?? null;
  }
}

export class MemoryKV implements KVNamespace {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null>;
  async get<T>(key: string, type: 'json'): Promise<T | null>;
  async get<T>(key: string, type?: 'json'): Promise<T | string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return type === 'json' ? (JSON.parse(entry.value) as T) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
