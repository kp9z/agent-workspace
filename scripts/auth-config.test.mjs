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

function loadAuthModule() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/auth.ts']);
  const modulePath = path.join(outDir, 'lib/auth.js');
  delete require.cache[modulePath];
  const auth = require(modulePath);
  return { auth, cleanup };
}

test('auth config infers google only from complete config and keeps secrets separated', () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  delete process.env.AGENT_WORKSPACE_AUTH_MODE;
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_ALLOWED_EMAILS = 'allowed@example.com';
  process.env.AUTH_COOKIE_SECRET = 'cookie-secret-value';
  process.env.APP_SHARED_SECRET = 'x'.repeat(32);

  const { auth, cleanup } = loadAuthModule();
  try {
    const config = auth.authConfig();
    assert.equal(config.authMode, 'google');
    assert.equal(config.googleEnabled, true);
    assert.equal(config.authEnabled, true);
    assert.equal(config.cookieSecret, 'cookie-secret-value');
    assert.equal(config.sharedSecret, 'x'.repeat(32));
    assert.equal(config.configError, undefined);
    assert.equal(auth.isEmailAllowed('allowed@example.com', config.allowedEmails), true);
    assert.equal(auth.isEmailAllowed('missing@example.com', config.allowedEmails), false);
    assert.equal(auth.isEmailAllowed('anyone@example.com', []), false);
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('auth config accepts deliberate none, infers shared-secret, and enforces minimum shared-secret length', () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'none';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_ALLOWED_EMAILS = 'allowed@example.com';
  process.env.AUTH_COOKIE_SECRET = 'cookie-secret-value';
  process.env.APP_SHARED_SECRET = 'too-short';

  const { auth, cleanup } = loadAuthModule();
  try {
    const noneConfig = auth.authConfig();
    assert.equal(noneConfig.authMode, 'none');
    assert.equal(noneConfig.configError, undefined);
    assert.equal(noneConfig.authEnabled, false);

    delete process.env.AGENT_WORKSPACE_AUTH_MODE;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_ALLOWED_EMAILS;
    delete process.env.AUTH_COOKIE_SECRET;
    process.env.APP_SHARED_SECRET = 's'.repeat(24);
    const sharedConfig = auth.authConfig();
    assert.equal(sharedConfig.authMode, 'shared-secret');
    assert.equal(sharedConfig.cookieSecret, 's'.repeat(24));
    assert.equal(sharedConfig.googleEnabled, false);

    process.env.AGENT_WORKSPACE_AUTH_MODE = 'shared-secret';
    process.env.APP_SHARED_SECRET = 'short-secret';
    const invalidShared = auth.authConfig();
    assert.equal(invalidShared.configError, 'Shared-secret auth requires APP_SHARED_SECRET to be at least 24 characters.');
    assert.equal(invalidShared.authEnabled, false);
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('auth config allows none in development/test when unconfigured and fails closed in production', () => {
  const savedEnv = snapshotEnv();
  delete process.env.AGENT_WORKSPACE_AUTH_MODE;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_ALLOWED_EMAILS;
  delete process.env.AUTH_COOKIE_SECRET;
  delete process.env.APP_SHARED_SECRET;

  process.env.NODE_ENV = 'test';
  const { auth, cleanup } = loadAuthModule();
  try {
    const devConfig = auth.authConfig();
    assert.equal(devConfig.authMode, 'none');
    assert.equal(devConfig.configError, undefined);

    process.env.NODE_ENV = 'production';
    const prodConfig = auth.authConfig();
    assert.equal(prodConfig.authMode, 'none');
    assert.equal(prodConfig.configError, 'Authentication is not configured. Set AGENT_WORKSPACE_AUTH_MODE or required credentials.');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('explicit google mode rejects missing cookie secret or empty allowlist', () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'google';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_ALLOWED_EMAILS = '';
  delete process.env.AUTH_COOKIE_SECRET;
  process.env.APP_SHARED_SECRET = 'x'.repeat(32);

  const { auth, cleanup } = loadAuthModule();
  try {
    const missingAllowlist = auth.authConfig();
    assert.equal(missingAllowlist.configError, 'Google auth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_COOKIE_SECRET, and GOOGLE_ALLOWED_EMAILS.');

    process.env.GOOGLE_ALLOWED_EMAILS = 'allowed@example.com';
    const missingCookieSecret = auth.authConfig();
    assert.equal(missingCookieSecret.configError, 'Google auth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_COOKIE_SECRET, and GOOGLE_ALLOWED_EMAILS.');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('invalid explicit auth mode fails closed instead of falling back to inferred credentials', () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'public';
  process.env.APP_SHARED_SECRET = 's'.repeat(24);

  const { auth, cleanup } = loadAuthModule();
  try {
    const config = auth.authConfig();
    assert.equal(config.authEnabled, false);
    assert.equal(config.configError, 'AGENT_WORKSPACE_AUTH_MODE must be google, shared-secret, or none.');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('malformed and insecure public Google APP_BASE_URL values fail closed', () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';
  process.env.AGENT_WORKSPACE_AUTH_MODE = 'google';
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.GOOGLE_ALLOWED_EMAILS = 'allowed@example.com';
  process.env.AUTH_COOKIE_SECRET = 'cookie-secret-value';

  const { auth, cleanup } = loadAuthModule();
  try {
    process.env.APP_BASE_URL = 'not a url';
    assert.equal(auth.authConfig().configError, 'APP_BASE_URL must be a valid absolute HTTP(S) origin.');

    process.env.APP_BASE_URL = 'https://workspace.example/path';
    assert.equal(auth.authConfig().configError, 'APP_BASE_URL must be a valid absolute HTTP(S) origin.');

    process.env.APP_BASE_URL = 'http://workspace.example';
    assert.equal(auth.authConfig().configError, 'APP_BASE_URL must use HTTPS for Google auth in production.');

    process.env.APP_BASE_URL = 'http://127.0.0.1:3100';
    assert.equal(auth.authConfig().configError, undefined);
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});
