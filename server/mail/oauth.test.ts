// server/mail/oauth.test.ts  (spec §4.4, plan 2 task 5)
import { describe, it, expect } from 'vitest';
import { buildAuthUrl, exchangeCode, signState, verifyState, createVerifier, challengeOf, redirectUri } from './oauth';

/* eslint-disable @typescript-eslint/no-explicit-any */
const env: any = {
  GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gs',
  MS_OAUTH_CLIENT_ID: 'mid', MS_OAUTH_CLIENT_SECRET: 'ms', MS_OAUTH_TENANT: 'tenant1',
};

describe('oauth', () => {
  it('builds provider auth URLs with PKCE and exact redirect URIs', () => {
    const g = new URL(buildAuthUrl('google', env, 'https://app.test', 'st', 'ch'));
    expect(g.origin + g.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(g.searchParams.get('client_id')).toBe('gid');
    expect(g.searchParams.get('redirect_uri')).toBe('https://app.test/api/mail/oauth/google/callback');
    expect(g.searchParams.get('response_type')).toBe('code');
    expect(g.searchParams.get('scope')).toContain('gmail.modify');
    expect(g.searchParams.get('scope')).toContain('gmail.send');
    expect(g.searchParams.get('access_type')).toBe('offline');
    expect(g.searchParams.get('prompt')).toBe('consent');
    expect(g.searchParams.get('state')).toBe('st');
    expect(g.searchParams.get('code_challenge')).toBe('ch');
    expect(g.searchParams.get('code_challenge_method')).toBe('S256');
    // The client secret never rides in a URL the browser can see.
    expect(g.search).not.toContain('gs');

    const m = new URL(buildAuthUrl('microsoft', env, 'https://app.test/', 'st', 'ch'));
    expect(m.origin).toBe('https://login.microsoftonline.com');
    expect(m.pathname).toBe('/tenant1/oauth2/v2.0/authorize');
    expect(m.searchParams.get('redirect_uri')).toBe('https://app.test/api/mail/oauth/microsoft/callback');
    expect(m.searchParams.get('response_mode')).toBe('query');
    expect(m.searchParams.get('scope')).toContain('offline_access');
    expect(m.searchParams.get('scope')).toContain('Mail.Send');
    expect(m.searchParams.get('code_challenge_method')).toBe('S256');
    expect(m.search).not.toContain('ms');
  });

  it('defaults the Microsoft tenant to common and names a missing env var', () => {
    const noTenant = new URL(buildAuthUrl('microsoft', { ...env, MS_OAUTH_TENANT: '' } as any, 'https://app.test', 's', 'c'));
    expect(noTenant.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(() => buildAuthUrl('google', {} as any, 'https://app.test', 's', 'c')).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
    expect(() => buildAuthUrl('microsoft', { MS_OAUTH_CLIENT_ID: 'x' } as any, 'https://app.test', 's', 'c')).toThrow(/MS_OAUTH_CLIENT_SECRET/);
  });

  it('state round-trips, is bound to the secret and expires', () => {
    const s = signState('secret', { userId: 'u1', provider: 'google', verifier: 'v' });
    expect(verifyState('secret', s)).toMatchObject({ userId: 'u1', provider: 'google', verifier: 'v' });
    expect(() => verifyState('other', s)).toThrow();
    expect(() => verifyState('secret', 'not-a-jwt')).toThrow();
    // 10-minute lifetime, per spec §7.
    const [, body] = s.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(600);
  });

  it('PKCE verifier/challenge are base64url S256', () => {
    const v = createVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(v);
    const c = challengeOf(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeOf(v)).toBe(c);
    expect(c).not.toBe(v);
  });

  it('redirectUri trims a trailing slash', () => {
    expect(redirectUri('https://app.test/', 'google')).toBe('https://app.test/api/mail/oauth/google/callback');
    expect(redirectUri('https://app.test', 'microsoft')).toBe('https://app.test/api/mail/oauth/microsoft/callback');
  });

  it('exchangeCode posts code+verifier and fetches identity', async () => {
    const calls: any[] = [];
    const f: any = async (url: string, init: any) => {
      calls.push({ url, init });
      if (/token/.test(url)) return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ email: 'me@bigbear.com', name: 'Nate' }), { status: 200 });
    };
    const r = await exchangeCode('google', env, 'https://app.test', 'code1', 'verif', f);
    expect(r).toEqual({ refreshToken: 'R', accessToken: 'A', email: 'me@bigbear.com', name: 'Nate' });
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].init.body).toContain('grant_type=authorization_code');
    expect(calls[0].init.body).toContain('code=code1');
    expect(calls[0].init.body).toContain('code_verifier=verif');
    expect(calls[0].init.body).toContain('redirect_uri=https%3A%2F%2Fapp.test%2Fapi%2Fmail%2Foauth%2Fgoogle%2Fcallback');
    expect(calls[1].url).toBe('https://openidconnect.googleapis.com/v1/userinfo');
    expect(calls[1].init.headers.Authorization).toBe('Bearer A');

    const noRt: any = async () => new Response(JSON.stringify({ access_token: 'A' }), { status: 200 });
    await expect(exchangeCode('google', env, 'https://app.test', 'c', 'v', noRt)).rejects.toThrow(/refresh token/);
  });

  it('exchangeCode reads the Microsoft tenant token endpoint and Graph identity', async () => {
    const calls: any[] = [];
    const f: any = async (url: string, init: any) => {
      calls.push({ url, init });
      if (/token/.test(url)) return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 });
      return new Response(JSON.stringify({ userPrincipalName: 'me@bb.com', displayName: 'Nate' }), { status: 200 });
    };
    const r = await exchangeCode('microsoft', env, 'https://app.test', 'c1', 'v1', f);
    expect(r).toEqual({ refreshToken: 'R', accessToken: 'A', email: 'me@bb.com', name: 'Nate' });
    expect(calls[0].url).toBe('https://login.microsoftonline.com/tenant1/oauth2/v2.0/token');
    expect(calls[1].url).toBe('https://graph.microsoft.com/v1.0/me');
    // `mail` wins over userPrincipalName when the mailbox differs from the login.
    const withMail: any = async (url: string) => /token/.test(url)
      ? new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 })
      : new Response(JSON.stringify({ mail: 'Box@bb.com', userPrincipalName: 'login@bb.com' }), { status: 200 });
    expect((await exchangeCode('microsoft', env, 'https://app.test', 'c', 'v', withMail)).email).toBe('box@bb.com');
  });

  it('exchangeCode surfaces provider errors without echoing the code or verifier', async () => {
    const bad: any = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code sekritcode for verifier sekritverif' }), { status: 400 });
    await expect(exchangeCode('google', env, 'https://app.test', 'sekritcode', 'sekritverif', bad))
      .rejects.toThrow(/invalid_grant/);
    const e = await exchangeCode('google', env, 'https://app.test', 'sekritcode', 'sekritverif', bad).then(() => new Error('should have thrown'), (x: Error) => x);
    expect(e.message).not.toContain('sekritcode');
    expect(e.message).not.toContain('sekritverif');

    const noIdentity: any = async (url: string) => /token/.test(url)
      ? new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R' }), { status: 200 })
      : new Response('nope', { status: 403 });
    await expect(exchangeCode('google', env, 'https://app.test', 'c', 'v', noIdentity)).rejects.toThrow(/email address/);
  });
});
