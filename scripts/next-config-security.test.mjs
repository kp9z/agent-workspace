import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function snapshotEnv() {
  return { NODE_ENV: process.env.NODE_ENV };
}

function restoreEnv(savedEnv) {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadNextConfig() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['next.config.ts']);
  const modulePath = path.join(outDir, 'next.config.js');
  delete require.cache[modulePath];
  const nextConfig = require(modulePath).default;
  return { nextConfig, cleanup };
}

function assertUniqueHeaderKeys(headers) {
  const keys = headers.map(({ key }) => key);
  assert.equal(new Set(keys).size, keys.length, `duplicate header keys found: ${keys.join(', ')}`);
}

test('next config emits production security headers and API no-store defaults', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'production';

  const { nextConfig, cleanup } = loadNextConfig();
  try {
    const headers = await nextConfig.headers();
    assert.deepEqual(headers, [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; manifest-src 'self'; worker-src 'self' blob:" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
        ],
      },
    ]);

    const browserHeaders = headers[0].headers;
    assertUniqueHeaderKeys(browserHeaders);
    const csp = browserHeaders.find((header) => header.key === 'Content-Security-Policy')?.value || '';
    assert.equal(csp.includes('\n'), false);
    assert.equal(csp.includes('\r'), false);
    assert.equal(csp.includes(','), false);
    assert.equal(csp.includes("'unsafe-eval'"), false);
    assert.equal(csp.includes('ws:'), false);
    assert.equal(csp.includes('wss:'), false);

    assertUniqueHeaderKeys(headers[1].headers);
    assert.deepEqual(headers[1].headers, [
      { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
    ]);
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('next config emits development-only unsafe-eval and websocket CSP allowances without HSTS', async () => {
  const savedEnv = snapshotEnv();
  process.env.NODE_ENV = 'development';

  const { nextConfig, cleanup } = loadNextConfig();
  try {
    const headers = await nextConfig.headers();
    const browserHeaders = headers.find((entry) => entry.source === '/:path*')?.headers || [];
    const csp = browserHeaders.find((header) => header.key === 'Content-Security-Policy')?.value || '';

    assert.equal(browserHeaders.some((header) => header.key === 'Strict-Transport-Security'), false);
    assert.equal(csp.includes("'unsafe-eval'"), true);
    assert.equal(csp.includes('ws:'), true);
    assert.equal(csp.includes('wss:'), true);
    assert.equal(csp.includes('\n'), false);
    assert.equal(csp.includes('\r'), false);
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});
