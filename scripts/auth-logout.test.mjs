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
  };
}

function restoreEnv(savedEnv) {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadModules() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/auth.ts', 'lib/rate-limit.ts', 'lib/request-safety.ts', 'app/api/auth/logout/route.ts']);
  const tempNodeModules = path.join(outDir, 'node_modules');
  require('node:fs').mkdirSync(tempNodeModules, { recursive: true });
  require('node:fs').symlinkSync(path.join(rootDir, 'node_modules', 'next'), path.join(tempNodeModules, 'next'), 'dir');
  const aliasRoot = path.join(tempNodeModules, '@');
  require('node:fs').mkdirSync(aliasRoot, { recursive: true });
  require('node:fs').symlinkSync(path.join(outDir, 'lib'), path.join(aliasRoot, 'lib'), 'dir');

  const logoutPath = path.join(outDir, 'app/api/auth/logout/route.js');
  delete require.cache[logoutPath];
  const { GET, POST } = require(logoutPath);
  return { GET, POST, cleanup };
}

function makeRequest(pathName = '/') {
  return {
    method: 'POST',
    url: `http://127.0.0.1${pathName}`,
    nextUrl: new URL(`http://127.0.0.1${pathName}`),
    headers: new Headers(),
    cookies: { get() { return undefined; } },
  };
}

test('logout is POST-only and clears canonical plus legacy cookies on POST', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'google';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_ALLOWED_EMAILS = 'allowed@example.com';
  process.env.AUTH_COOKIE_SECRET = 'cookie-secret-value';
  const { GET, POST, cleanup } = loadModules();
  try {
    const getResponse = await GET(makeRequest());
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get('allow'), 'POST');
    assert.equal(getResponse.headers.get('set-cookie'), null);

    const postResponse = await POST(makeRequest());
    assert.equal(postResponse.status, 303);
    assert.equal(postResponse.headers.get('location'), 'http://127.0.0.1/api/auth/login');
    const setCookie = postResponse.headers.get('set-cookie') || '';
    assert.match(setCookie, /agent_workspace_session=/);
    assert.match(setCookie, /kira_ws_session=/);
    assert.match(setCookie, /agent_workspace_oauth_state=/);
    assert.match(setCookie, /kira_ws_oauth_state=/);
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});
