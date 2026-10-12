import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthClient } from './index.js';

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queue.shift() ?? { status: 500 };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth client', () => {
  it('always sends credentials and JSON bodies, never caches', async () => {
    const calls = mockFetch([{ status: 200, body: { status: 'AUTHENTICATED' } }]);
    const result = await createAuthClient('http://api.test/').login(
      'customer',
      'a@example.test',
      'pw',
    );
    expect(result).toEqual({ ok: true, data: { status: 'AUTHENTICATED' } });
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/customer/login');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('normalizes repeated trailing slashes without a regular expression', async () => {
    const calls = mockFetch([{ status: 200, body: { id: 'x' } }]);
    await createAuthClient('http://api.test////').me('customer');
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/customer/me');
  });

  it('fetches a CSRF token in memory and sends it in X-CSRF-Token', async () => {
    const calls = mockFetch([{ status: 200, body: { csrfToken: 'v1.1.n.m' } }, { status: 204 }]);
    const result = await createAuthClient('http://api.test').logout('staff');
    expect(result.ok).toBe(true);
    expect(calls[1]?.url).toBe('http://api.test/v1/auth/staff/logout');
    expect((calls[1]?.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('v1.1.n.m');
  });

  it('treats logout without a session as success (idempotent)', async () => {
    mockFetch([{ status: 401, body: { code: 'UNAUTHENTICATED', message: 'x' } }, { status: 204 }]);
    expect((await createAuthClient('http://api.test').logout('crew')).ok).toBe(true);
  });

  it('returns the public error code and message', async () => {
    mockFetch([
      {
        status: 401,
        body: { code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect.' },
      },
    ]);
    expect(await createAuthClient('http://api.test').login('crew', 'a@example.test', 'pw')).toEqual(
      {
        ok: false,
        error: {
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Email ou mot de passe incorrect.',
        },
      },
    );
  });

  it('reports network failures without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    const result = await createAuthClient('http://api.test').me('customer');
    expect(result).toMatchObject({ ok: false, error: { code: 'NETWORK_ERROR', status: 0 } });
  });

  it('never touches browser storage', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    mockFetch([
      { status: 200, body: { csrfToken: 't' } },
      { status: 204 },
      { status: 200, body: { status: 'AUTHENTICATED' } },
    ]);
    const auth = createAuthClient('http://api.test');
    await auth.logout('customer');
    await auth.login('customer', 'a@example.test', 'pw');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
  });
});

describe('admin client', () => {
  it('sends admin mutations with an in-memory CSRF token and encodes path parameters', async () => {
    const calls = mockFetch([{ status: 200, body: { csrfToken: 'v1.1.n.m' } }, { status: 204 }]);
    const result = await createAuthClient('http://api.test').admin.revokeSessions('id/../x');
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('http://api.test/v1/auth/staff/csrf');
    expect(calls[1]?.url).toBe(
      'http://api.test/v1/admin/identities/id%2F..%2Fx/sessions/revoke-all',
    );
    expect((calls[1]?.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('v1.1.n.m');
  });

  it('builds paginated queries without undefined values', async () => {
    const calls = mockFetch([{ status: 200, body: { items: [], nextCursor: null } }]);
    await createAuthClient('http://api.test').admin.identities({ realm: 'crew', limit: 20 });
    expect(calls[0]?.url).toBe('http://api.test/v1/admin/identities?realm=crew&limit=20');
  });
});
