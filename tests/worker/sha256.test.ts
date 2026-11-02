import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256, toHex } from '../../worker/src/utils/sha256';
import { constantTimeEqual, sha256Hex, sha256StreamHex } from '../../worker/src/utils/hash';

const nodeSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('incremental SHA-256', () => {
  it('matches node:crypto for a range of input sizes', () => {
    for (const size of [0, 1, 3, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000, 65_537]) {
      const data = randomBytes(size);
      const hasher = new Sha256();
      hasher.update(new Uint8Array(data));
      expect(hasher.digestHex()).toBe(nodeSha256(new Uint8Array(data)));
    }
  });

  it('streams correctly regardless of chunk boundaries', () => {
    const data = new Uint8Array(randomBytes(10_000));
    const expected = nodeSha256(data);

    for (const chunkSize of [1, 7, 64, 999, 10_000]) {
      const hasher = new Sha256();
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        hasher.update(data.subarray(offset, offset + chunkSize));
      }
      expect(hasher.digestHex()).toBe(expected);
    }
  });

  it('hashes UTF-8 strings like Buffer does', () => {
    expect(sha256Hex('aether')).toBe(createHash('sha256').update('aether', 'utf8').digest('hex'));
  });

  it('rejects reuse after finalisation', () => {
    const hasher = new Sha256();
    hasher.update('x');
    hasher.digest();
    expect(() => hasher.update('y')).toThrow();
    expect(() => hasher.digest()).toThrow();
  });

  it('hashes a ReadableStream and reports the byte count', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const all = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const result = await sha256StreamHex(stream);
    expect(result.bytes).toBe(6);
    expect(result.sha256).toBe(nodeSha256(all));
  });

  it('aborts a stream that exceeds the configured maximum', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    await expect(sha256StreamHex(stream, { maxBytes: 12 })).rejects.toThrow(/exceeded/);
  });

  it('compares digests in constant time', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('encodes hex with leading zeroes preserved', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 255]))).toBe('00010fff');
  });
});
