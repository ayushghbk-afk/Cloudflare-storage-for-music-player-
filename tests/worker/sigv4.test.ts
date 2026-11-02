import { describe, expect, it } from 'vitest';
import aws4 from 'aws4';
import { presignUrl, signRequest, toAmzDate, uriEncode } from '../../worker/src/storage/sigv4';

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const referenceSign = (request: Parameters<typeof aws4.sign>[0]): Parameters<typeof aws4.sign>[0] =>
  aws4.sign(request, credentials);

/** Pull `X-Amz-Date` out of a presigned URL produced by aws4. */
function amzDateFromUrl(url: string): Date {
  const params = new URL(url, 'https://placeholder').searchParams;
  const value = params.get('X-Amz-Date');
  if (!value) throw new Error('missing X-Amz-Date');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  return new Date(iso);
}

describe('SigV4 canonicalisation helpers', () => {
  it('percent-encodes per RFC 3986', () => {
    expect(uriEncode('a b')).toBe('a%20b');
    expect(uriEncode('a+b')).toBe('a%2Bb');
    expect(uriEncode("!*'()")).toBe('%21%2A%27%28%29');
    expect(uriEncode('/a/b')).toBe('%2Fa%2Fb');
    expect(uriEncode('/a/b', false)).toBe('/a/b');
    expect(uriEncode('ünïcode')).toBe('%C3%BCn%C3%AFcode');
  });

  it('formats the amz date', () => {
    const { amzDate, dateStamp } = toAmzDate(new Date('2026-01-02T03:04:05.678Z'));
    expect(amzDate).toBe('20260102T030405Z');
    expect(dateStamp).toBe('20260102');
  });
});

describe('presigned URLs', () => {
  it('matches the aws4 reference implementation', async () => {
    const reference = referenceSign({
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt?X-Amz-Expires=300',
      method: 'GET',
      signQuery: true,
      region: 'us-east-1',
      service: 's3',
    });
    const referenceUrl = new URL(reference.path!, 'https://examplebucket.s3.amazonaws.com');
    const referenceSignature = referenceUrl.searchParams.get('X-Amz-Signature');

    const ours = await presignUrl({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      credentials,
      region: 'us-east-1',
      service: 's3',
      expiresIn: 300,
      date: amzDateFromUrl(reference.path!),
    });
    const oursUrl = new URL(ours);

    expect(oursUrl.searchParams.get('X-Amz-Signature')).toBe(referenceSignature);
    expect(oursUrl.searchParams.get('X-Amz-Credential')).toBe(referenceUrl.searchParams.get('X-Amz-Credential'));
    expect(oursUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(oursUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  it('matches aws4 for keys with spaces and unicode', async () => {
    const reference = referenceSign({
      host: 'accountid.r2.cloudflarestorage.com',
      path: '/my-bucket/audio/user%201/a%20song%20%C3%BC.m4a?X-Amz-Expires=600',
      method: 'GET',
      signQuery: true,
      region: 'auto',
      service: 's3',
    });
    const referenceUrl = new URL(reference.path!, 'https://accountid.r2.cloudflarestorage.com');

    const ours = await presignUrl({
      method: 'GET',
      url: 'https://accountid.r2.cloudflarestorage.com/my-bucket/audio/user%201/a%20song%20%C3%BC.m4a',
      credentials,
      region: 'auto',
      service: 's3',
      expiresIn: 600,
      date: amzDateFromUrl(reference.path!),
    });

    expect(new URL(ours).searchParams.get('X-Amz-Signature')).toBe(referenceUrl.searchParams.get('X-Amz-Signature'));
  });

  it('includes a session token when temporary credentials are used', async () => {
    const url = await presignUrl({
      method: 'GET',
      url: 'https://account.r2.cloudflarestorage.com/bucket/key.mp3',
      credentials: { ...credentials, sessionToken: 'session-token-value' },
      region: 'auto',
      service: 's3',
      expiresIn: 60,
    });
    expect(new URL(url).searchParams.get('X-Amz-Security-Token')).toBe('session-token-value');
  });

  it('clamps expiry to seven days', async () => {
    const url = await presignUrl({
      method: 'GET',
      url: 'https://account.r2.cloudflarestorage.com/bucket/key.mp3',
      credentials,
      region: 'auto',
      service: 's3',
      expiresIn: 10_000_000,
    });
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('604800');
  });

  it('presigns PUT as well as GET', async () => {
    const url = await presignUrl({
      method: 'PUT',
      url: 'https://account.r2.cloudflarestorage.com/bucket/new-object.mp3',
      credentials,
      region: 'auto',
      service: 's3',
      expiresIn: 900,
    });
    expect(url).toContain('X-Amz-Signature=');
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});

describe('header-signed requests', () => {
  it('produces the same signature as aws4 for a PUT with a body', async () => {
    const body = 'hello world';
    const reference = referenceSign({
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test%20object.txt',
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'text/plain' },
      region: 'us-east-1',
      service: 's3',
    });

    const referenceAuth = reference.headers!.Authorization as string;
    const referenceDate = reference.headers!['X-Amz-Date'] as string;
    const referenceDateParsed = new Date(
      `${referenceDate.slice(0, 4)}-${referenceDate.slice(4, 6)}-${referenceDate.slice(6, 8)}T${referenceDate.slice(9, 11)}:${referenceDate.slice(11, 13)}:${referenceDate.slice(13, 15)}Z`
    );

    const signed = await signRequest({
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test%20object.txt',
      // content-length participates in the signature, exactly as the adapter does.
      headers: { 'content-type': 'text/plain', 'content-length': String(new TextEncoder().encode(body).byteLength) },
      body,
      credentials,
      region: 'us-east-1',
      service: 's3',
      date: referenceDateParsed,
    });

    expect(signed.headers['x-amz-content-sha256']).toBe(reference.headers!['X-Amz-Content-Sha256']);
    expect(signed.headers['authorization']).toBe(referenceAuth);
    expect(signed.headers.host).toBeUndefined();
  });

  it('signs an empty-body DELETE deterministically', async () => {
    const date = new Date('2026-05-06T07:08:09Z');
    const first = await signRequest({
      method: 'DELETE',
      url: 'https://account.r2.cloudflarestorage.com/bucket/key.flac',
      credentials,
      region: 'auto',
      service: 's3',
      date,
    });
    const second = await signRequest({
      method: 'DELETE',
      url: 'https://account.r2.cloudflarestorage.com/bucket/key.flac',
      credentials,
      region: 'auto',
      service: 's3',
      date,
    });
    expect(first.headers.authorization).toBe(second.headers.authorization);
    expect(first.headers['x-amz-date']).toBe('20260506T070809Z');
    expect(first.headers.authorization).toContain('SignedHeaders=');
  });
});
