/**
 * Minimal typings for the `aws4` reference implementation, used only to
 * cross-check our SigV4 signer in tests.
 */
declare module 'aws4' {
  export interface Aws4Request {
    host?: string;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    service?: string;
    region?: string;
    signQuery?: boolean;
  }

  export interface Aws4Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }

  export function sign(request: Aws4Request, credentials: Aws4Credentials): Aws4Request;

  const aws4: { sign: typeof sign };
  export default aws4;
}
