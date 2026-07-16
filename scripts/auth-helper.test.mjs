import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function loadAuthModule() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/auth.ts']);
  const modulePath = path.join(outDir, 'lib/auth.js');
  delete require.cache[modulePath];
  const auth = require(modulePath);
  return { auth, cleanup };
}

function requestFor(url, headers = {}) {
  return {
    headers: new Headers(headers),
    nextUrl: new URL(url),
  };
}

test('constant-time secret comparison is correct for matching and mismatching values', async () => {
  const { auth, cleanup } = loadAuthModule();
  try {
    assert.equal(await auth.constantTimeSecretEquals('password', 'password'), true);
    assert.equal(await auth.constantTimeSecretEquals('password', 'passw0rd'), false);
    assert.equal(await auth.constantTimeSecretEquals('password', 'password-but-longer'), false);
  } finally {
    cleanup();
  }
});

test('secure cookie helper prefers app base url, then forwarded proto, then request protocol', () => {
  const { auth, cleanup } = loadAuthModule();
  try {
    assert.equal(auth.cookieSecureForRequest(requestFor('http://127.0.0.1'), 'https://app.example.com'), true);
    assert.equal(auth.cookieSecureForRequest(requestFor('http://127.0.0.1', { 'x-forwarded-proto': 'https' })), true);
    assert.equal(auth.cookieSecureForRequest(requestFor('http://127.0.0.1', { 'x-forwarded-proto': 'http' })), false);
    assert.equal(auth.cookieSecureForRequest(requestFor('https://127.0.0.1')), true);
    assert.equal(auth.cookieSecureForRequest(requestFor('http://127.0.0.1')), false);
  } finally {
    cleanup();
  }
});
