import { Sha256, toHex } from './sha256';

/** Hex SHA-256 of a buffer or string. */
export function sha256Hex(data: Uint8Array | ArrayBuffer | string): string {
  const hasher = new Sha256();
  hasher.update(data);
  return hasher.digestHex();
}

/**
 * Hash a byte stream without buffering it.
 *
 * Returns the hex digest and the number of bytes consumed. Used to fingerprint
 * uploads that are streamed through the Worker (no full-file memory footprint).
 */
export async function sha256StreamHex(
  stream: ReadableStream<Uint8Array>,
  options: { maxBytes?: number; onBytes?: (total: number) => void } = {}
): Promise<{ sha256: string; bytes: number }> {
  const hasher = new Sha256();
  const reader = stream.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        throw new Error(`stream exceeded maximum size of ${options.maxBytes} bytes`);
      }
      hasher.update(value);
      options.onBytes?.(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return { sha256: hasher.digestHex(), bytes };
}

/** Reads only the first `length` bytes of a stream and cancels the rest. */
export async function readStreamPrefix(stream: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < length) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const take = value.subarray(0, Math.min(value.byteLength, length - total));
      chunks.push(take.slice());
      total += take.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Constant-time comparison for hex digests / secrets of equal length. */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export { toHex };
