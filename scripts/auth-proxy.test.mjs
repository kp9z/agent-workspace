import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function snapshotEnv() {
  return {
    NODE_ENV: process.env.NODE_ENV,
    AGENT_WORKSPACE_AUTH_MODE: process.env.AGENT_WORKSPACE_AUTH_MODE,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_ALLOWED_EMAILS: process.env.GOOGLE_ALLOWED_EMAILS,
    AUTH_COOKIE_SECRET: process.env.AUTH_COOKIE_SECRET,
    APP_SHARED_SECRET: process.env.APP_SHARED_SECRET,
    APP_BASE_URL: process.env.APP_BASE_URL,
  };
}

function restoreEnv(savedEnv) {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadModules() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/auth.ts', 'lib/rate-limit.ts', 'lib/request-safety.ts', 'proxy.ts']);
  const tempNodeModules = path.join(outDir, 'node_modules');
  require('node:fs').mkdirSync(tempNodeModules, { recursive: true });
  require('node:fs').symlinkSync(path.join(rootDir, 'node_modules', 'next'), path.join(tempNodeModules, 'next'), 'dir');
  const aliasRoot = path.join(tempNodeModules, '@');
  require('node:fs').mkdirSync(aliasRoot, { recursive: true });
  require('node:fs').symlinkSync(path.join(outDir, 'lib'), path.join(aliasRoot, 'lib'), 'dir');

  const authPath = path.join(outDir, 'lib/auth.js');
  const rateLimitPath = path.join(outDir, 'lib/rate-limit.js');
  const proxyPath = path.join(outDir, 'proxy.js');
  delete require.cache[authPath];
  delete require.cache[rateLimitPath];
  delete require.cache[proxyPath];
  const auth = require(authPath);
  const rateLimit = require(rateLimitPath);
  const { proxy } = require(proxyPath);
  return { auth, rateLimit, proxy, cleanup };
}

function makeRequest({ method = 'GET', pathName = '/', headers = {}, cookies = {} } = {}) {
  return {
    method,
    url: `http://127.0.0.1${pathName}`,
    nextUrl: new URL(`http://127.0.0.1${pathName}`),
    headers: new Headers(headers),
    cookies: {
      get(name) {
        const value = cookies[name];
        return value === undefined ? undefined : { value };
      },
    },
  };
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`ignored:${password}`).toString('base64')}`;
}

test('proxy passes through when auth is deliberately disabled', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'none';
  process.env.APP_SHARED_SECRET = 'x'.repeat(32);
  const { proxy, cleanup } = loadModules();
  try {
    const response = await proxy(makeRequest());
    assert.equal(response.headers.get('x-middleware-next'), '1');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('proxy accepts constant-time shared-secret basic auth and keeps username ignored', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'shared-secret';
  process.env.APP_SHARED_SECRET = 's'.repeat(24);
  const { proxy, cleanup } = loadModules();
  try {
    const response = await proxy(makeRequest({ headers: { authorization: basicAuth('s'.repeat(24)) } }));
    assert.equal(response.headers.get('x-middleware-next'), '1');

    const denied = await proxy(makeRequest({ headers: { authorization: basicAuth('wrong-secret-value-123') } }));
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), 'Basic realm="Agent Workspace"');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('proxy redirects anonymous google browser requests and accepts signed google sessions', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'google';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_ALLOWED_EMAILS = 'allowed@example.com';
  process.env.AUTH_COOKIE_SECRET = 'cookie-secret-value';
  const { auth, proxy, cleanup } = loadModules();
  try {
    const redirectResponse = await proxy(makeRequest({ pathName: '/' }));
    assert.equal(redirectResponse.status, 307);
    assert.equal(redirectResponse.headers.get('location'), 'http://127.0.0.1/api/auth/login');

    const sessionToken = await auth.createSessionToken({ email: 'allowed@example.com' }, 'cookie-secret-value');
    const allowedResponse = await proxy(makeRequest({ cookies: { [auth.SESSION_COOKIE]: sessionToken } }));
    assert.equal(allowedResponse.headers.get('x-middleware-next'), '1');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('proxy fails closed with a generic 503 when production auth is unconfigured', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  delete process.env.AGENT_WORKSPACE_AUTH_MODE;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_ALLOWED_EMAILS;
  delete process.env.AUTH_COOKIE_SECRET;
  delete process.env.APP_SHARED_SECRET;
  const { proxy, cleanup } = loadModules();
  try {
    const response = await proxy(makeRequest());
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body, 'Authentication configuration error. Set AGENT_WORKSPACE_AUTH_MODE and required credentials.');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('proxy rate limits expensive mutations after origin checks while leaving GET traffic unchanged', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'none';
  const { rateLimit, proxy, cleanup } = loadModules();
  rateLimit.resetRateLimitStateForTests();
  try {
    const headers = { 'x-real-ip': '192.0.2.55' };
    for (let index = 0; index < 35; index += 1) {
      const rejected = await proxy(makeRequest({
        method: 'POST',
        pathName: '/api/queue',
        headers: { ...headers, origin: 'https://evil.example' },
      }));
      assert.equal(rejected.status, 403);
    }

    for (let index = 0; index < 30; index += 1) {
      const allowed = await proxy(makeRequest({ method: 'POST', pathName: '/api/queue', headers }));
      assert.equal(allowed.headers.get('x-middleware-next'), '1');
    }

    const denied = await proxy(makeRequest({ method: 'POST', pathName: '/api/queue', headers }));
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { error: 'Too many requests' });
    assert.equal(denied.headers.get('ratelimit-limit'), '30');
    assert.equal(denied.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(denied.headers.get('retry-after')) > 0);

    const getResponse = await proxy(makeRequest({ method: 'GET', pathName: '/api/queue', headers }));
    assert.equal(getResponse.headers.get('x-middleware-next'), '1');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});
