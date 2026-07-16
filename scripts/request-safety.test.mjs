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
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/auth.ts', 'lib/rate-limit.ts', 'lib/request-safety.ts', 'proxy.ts', 'app/api/auth/logout/route.ts']);
  const tempNodeModules = path.join(outDir, 'node_modules');
  require('node:fs').mkdirSync(tempNodeModules, { recursive: true });
  require('node:fs').symlinkSync(path.join(rootDir, 'node_modules', 'next'), path.join(tempNodeModules, 'next'), 'dir');
  const aliasRoot = path.join(tempNodeModules, '@');
  require('node:fs').mkdirSync(aliasRoot, { recursive: true });
  require('node:fs').symlinkSync(path.join(outDir, 'lib'), path.join(aliasRoot, 'lib'), 'dir');

  const authPath = path.join(outDir, 'lib/auth.js');
  const safetyPath = path.join(outDir, 'lib/request-safety.js');
  const proxyPath = path.join(outDir, 'proxy.js');
  const logoutPath = path.join(outDir, 'app/api/auth/logout/route.js');
  delete require.cache[authPath];
  delete require.cache[safetyPath];
  delete require.cache[proxyPath];
  delete require.cache[logoutPath];
  return {
    auth: require(authPath),
    safety: require(safetyPath),
    proxy: require(proxyPath).proxy,
    logout: require(logoutPath),
    cleanup,
  };
}

function makeRequest({ method = 'GET', url = 'http://127.0.0.1/', headers = {}, cookies = {} } = {}) {
  return {
    method,
    url,
    nextUrl: new URL(url),
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

test('origin helper accepts matching configured origins and rejects cross-origin or malformed origins', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.APP_BASE_URL = 'https://workspace.example.com';
  const { safety, cleanup } = loadModules();
  try {
    assert.deepEqual(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { origin: 'https://workspace.example.com' },
      }), 'https://workspace.example.com'),
      { ok: true },
    );

    assert.deepEqual(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { origin: 'https://workspace.example.com:443' },
      }), 'https://workspace.example.com'),
      { ok: true },
    );

    assert.equal(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { origin: 'https://workspace.example.com/path' },
      }), 'https://workspace.example.com').ok,
      false,
    );

    assert.equal(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { origin: 'https://evil.example.com' },
      })).ok,
      false,
    );

    assert.equal(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { origin: 'null' },
      })).ok,
      false,
    );

    assert.equal(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { origin: 'not-a-url' },
      })).ok,
      false,
    );
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('origin helper allows missing origin for same-site or CLI-style requests but rejects cross-site fetch metadata', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  delete process.env.APP_BASE_URL;
  const { safety, cleanup } = loadModules();
  try {
    assert.equal(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { 'sec-fetch-site': 'cross-site' },
      })).ok,
      false,
    );

    assert.deepEqual(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
        headers: { 'sec-fetch-site': 'same-site' },
      })),
      { ok: true },
    );

    assert.deepEqual(
      safety.validateUnsafeRequestOrigin(makeRequest({
        method: 'POST',
        url: 'http://127.0.0.1/api/projects',
      })),
      { ok: true },
    );
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('proxy rejects cross-site unsafe requests even when auth is disabled, while same-origin, CLI, and GET requests pass through', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'none';
  const { proxy, cleanup } = loadModules();
  try {
    const crossSite = await proxy(makeRequest({
      method: 'POST',
      url: 'http://127.0.0.1/api/projects',
      headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' },
    }));
    assert.equal(crossSite.status, 403);

    const sameOrigin = await proxy(makeRequest({
      method: 'POST',
      url: 'http://127.0.0.1/api/projects',
      headers: { origin: 'http://127.0.0.1' },
    }));
    assert.equal(sameOrigin.headers.get('x-middleware-next'), '1');

    const cliStyle = await proxy(makeRequest({
      method: 'POST',
      url: 'http://127.0.0.1/api/projects',
    }));
    assert.equal(cliStyle.headers.get('x-middleware-next'), '1');

    const getResponse = await proxy(makeRequest({
      method: 'GET',
      url: 'http://127.0.0.1/api/projects',
      headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' },
    }));
    assert.equal(getResponse.headers.get('x-middleware-next'), '1');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('logout POST rejects cross-origin requests without clearing cookies and accepts same-origin requests', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'google';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_ALLOWED_EMAILS = 'allowed@example.com';
  process.env.AUTH_COOKIE_SECRET = 'cookie-secret-value';
  const { logout, cleanup } = loadModules();
  try {
    const crossOrigin = await logout.POST(makeRequest({
      method: 'POST',
      url: 'http://127.0.0.1/api/auth/logout',
      headers: { origin: 'https://evil.example.com' },
    }));
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get('set-cookie'), null);

    const sameOrigin = await logout.POST(makeRequest({
      method: 'POST',
      url: 'http://127.0.0.1/api/auth/logout',
      headers: { origin: 'http://127.0.0.1' },
    }));
    assert.equal(sameOrigin.status, 303);
    assert.equal(sameOrigin.headers.get('location'), 'http://127.0.0.1/api/auth/login');
    const setCookie = sameOrigin.headers.get('set-cookie') || '';
    assert.match(setCookie, /agent_workspace_session=/);
    assert.match(setCookie, /kira_ws_session=/);
    assert.match(setCookie, /agent_workspace_oauth_state=/);
    assert.match(setCookie, /kira_ws_oauth_state=/);
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});
