import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);
const encoder = new TextEncoder();

function collectTsFiles(dir, prefix = '') {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full, relative));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path.posix.join('lib', relative).replace(/\\/g, '/'));
    }
  }
  return files;
}

function loadModules() {
  const libFiles = collectTsFiles(path.join(rootDir, 'lib'));
  const { outDir, cleanup } = transpileTsFiles(rootDir, [...libFiles, 'app/api/activity/route.ts']);
  const tempNodeModules = path.join(outDir, 'node_modules');
  require('node:fs').mkdirSync(tempNodeModules, { recursive: true });
  require('node:fs').symlinkSync(path.join(rootDir, 'node_modules', 'next'), path.join(tempNodeModules, 'next'), 'dir');
  require('node:fs').symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');
  const aliasRoot = path.join(tempNodeModules, '@');
  require('node:fs').mkdirSync(aliasRoot, { recursive: true });
  require('node:fs').symlinkSync(path.join(outDir, 'lib'), path.join(aliasRoot, 'lib'), 'dir');

  const requestBodyPath = path.join(outDir, 'lib/request-body.js');
  const activityPath = path.join(outDir, 'app/api/activity/route.js');
  delete require.cache[requestBodyPath];
  delete require.cache[activityPath];
  return {
    requestBody: require(requestBodyPath),
    activity: require(activityPath),
    cleanup,
  };
}

function makeRequest(body, headers = {}) {
  const init = {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body,
  };
  if (body instanceof ReadableStream) {
    init.duplex = 'half';
  }
  return new Request('http://127.0.0.1/api/test', init);
}

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

function jsonBodyWithExactSize(totalBytes) {
  const prefix = '{"data":"';
  const suffix = '"}';
  const fillerBytes = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (fillerBytes < 0) throw new Error('target size too small');
  return `${prefix}${'a'.repeat(fillerBytes)}${suffix}`;
}

test('bounded JSON parsing accepts valid JSON and rejects malformed, wrong type, declared-too-large, streamed-too-large, and multibyte-over-limit bodies', async () => {
  const { requestBody, cleanup } = loadModules();
  try {
    const valid = await requestBody.parseJsonBody(makeRequest('{"name":"Agent"}'));
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.deepEqual(valid.value, { name: 'Agent' });
    }

    const malformed = await requestBody.parseJsonBody(makeRequest('{"name":'));
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.equal(malformed.status, 400);
    }

    const wrongType = await requestBody.parseJsonBody(new Request('http://127.0.0.1/api/test', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: '{}',
    }));
    assert.equal(wrongType.ok, false);
    if (!wrongType.ok) {
      assert.equal(wrongType.status, 415);
    }

    const declaredTooLarge = await requestBody.parseJsonBody(makeRequest('{}', {
      'content-length': String(requestBody.JSON_BODY_GENERAL_LIMIT_BYTES + 1),
    }));
    assert.equal(declaredTooLarge.ok, false);
    if (!declaredTooLarge.ok) {
      assert.equal(declaredTooLarge.status, 413);
    }

    const streamedTooLarge = await requestBody.parseJsonBody(new Request('http://127.0.0.1/api/test', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: streamFromChunks(['{"data":"', 'abcde', 'fghij', 'k"}']),
      duplex: 'half',
    }), 12);
    assert.equal(streamedTooLarge.ok, false);
    if (!streamedTooLarge.ok) {
      assert.equal(streamedTooLarge.status, 413);
    }

    const multibyteBody = '{"emoji":"😀"}';
    const multibyteLimit = multibyteBody.length + 1;
    assert.ok(Buffer.byteLength(multibyteBody) > multibyteLimit);
    const multibyteResult = await requestBody.parseJsonBody(makeRequest(multibyteBody), multibyteLimit);
    assert.equal(multibyteResult.ok, false);
    if (!multibyteResult.ok) {
      assert.equal(multibyteResult.status, 413);
    }
  } finally {
    cleanup();
  }
});

test('oversized streamed bodies are cancelled after the limit is crossed', async () => {
  const { requestBody, cleanup } = loadModules();
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode('{"data":"payload"}'));
    },
    cancel() {
      cancelled = true;
    },
  });

  try {
    const result = await requestBody.parseJsonBody(new Request('http://127.0.0.1/api/test', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: stream,
      duplex: 'half',
    }), 8);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 413);
    assert.equal(cancelled, true);
  } finally {
    cleanup();
  }
});

test('attachment-sized boundary accepts exact limit and rejects limit+1', async () => {
  const { requestBody, cleanup } = loadModules();
  try {
    const exactBody = jsonBodyWithExactSize(requestBody.JSON_BODY_ATTACHMENT_LIMIT_BYTES);
    const exactResult = await requestBody.parseJsonBody(makeRequest(exactBody), requestBody.JSON_BODY_ATTACHMENT_LIMIT_BYTES);
    assert.equal(exactResult.ok, true);

    const overBody = jsonBodyWithExactSize(requestBody.JSON_BODY_ATTACHMENT_LIMIT_BYTES + 1);
    const overResult = await requestBody.parseJsonBody(makeRequest(overBody), requestBody.JSON_BODY_ATTACHMENT_LIMIT_BYTES);
    assert.equal(overResult.ok, false);
    if (!overResult.ok) {
      assert.equal(overResult.status, 413);
    }
  } finally {
    cleanup();
  }
});

test('representative route returns 413 before route logic when the declared body size is excessive', async () => {
  const { requestBody, activity, cleanup } = loadModules();
  try {
    const response = await activity.POST({
      method: 'POST',
      url: 'http://127.0.0.1/api/activity',
      nextUrl: new URL('http://127.0.0.1/api/activity'),
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(requestBody.JSON_BODY_GENERAL_LIMIT_BYTES + 1),
      }),
      body: null,
      cookies: { get() { return undefined; } },
    });
    assert.equal(response.status, 413);
  } finally {
    cleanup();
  }
});
