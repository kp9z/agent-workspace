import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-server-perf-'));
const originalEnv = {
  HERMES_WEB_UI_DEBUG_PERF: process.env.HERMES_WEB_UI_DEBUG_PERF,
  KIRA_DEBUG_PERF: process.env.KIRA_DEBUG_PERF,
  HERMES_WEB_UI_DEBUG: process.env.HERMES_WEB_UI_DEBUG,
};

process.env.HERMES_WEB_UI_DATA_DIR = dataDir;
delete process.env.HERMES_WEB_UI_DEBUG_PERF;
delete process.env.KIRA_DEBUG_PERF;
delete process.env.HERMES_WEB_UI_DEBUG;

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(rootDir, [
  'lib/workspace-env.ts',
  'lib/server-perf.ts',
]);

const require = createRequire(import.meta.url);
const { serverPerfEnabled, serverPerfMark, utf8ByteLength } = require(path.join(outDir, 'lib/server-perf.js'));

process.on('exit', () => {
  cleanup();
  rmSync(dataDir, { recursive: true, force: true });
  if (originalEnv.HERMES_WEB_UI_DEBUG_PERF === undefined) delete process.env.HERMES_WEB_UI_DEBUG_PERF;
  else process.env.HERMES_WEB_UI_DEBUG_PERF = originalEnv.HERMES_WEB_UI_DEBUG_PERF;
  if (originalEnv.KIRA_DEBUG_PERF === undefined) delete process.env.KIRA_DEBUG_PERF;
  else process.env.KIRA_DEBUG_PERF = originalEnv.KIRA_DEBUG_PERF;
  if (originalEnv.HERMES_WEB_UI_DEBUG === undefined) delete process.env.HERMES_WEB_UI_DEBUG;
  else process.env.HERMES_WEB_UI_DEBUG = originalEnv.HERMES_WEB_UI_DEBUG;
});

test('server perf logging is disabled by default and emits only metadata when enabled', () => {
  const originalInfo = console.info;
  const infoCalls = [];
  try {
    console.info = (...args) => {
      infoCalls.push(args);
    };

    assert.equal(serverPerfEnabled(), false);
    serverPerfMark('sessions:list', {
      duration_ms: 12,
      count: 3,
      payload_bytes: utf8ByteLength('event: session\ndata: {"id":"abc"}\n\n'),
      sse_bytes: utf8ByteLength('event: session\ndata: {"id":"abc"}\n\n'),
    });
    assert.equal(infoCalls.length, 0);

    process.env.HERMES_WEB_UI_DEBUG_PERF = '1';
    assert.equal(serverPerfEnabled(), true);
    serverPerfMark('sse:event', {
      duration_ms: 7,
      payload_bytes: 64,
      sse_bytes: 96,
      count: 1,
    });

    assert.equal(infoCalls.length, 1);
    const [message, detail] = infoCalls[0];
    assert.equal(message, '[agent-workspace-perf] sse:event');
    assert.equal(typeof detail.time, 'number');
    assert.deepEqual(Object.keys(detail).sort(), ['count', 'duration_ms', 'payload_bytes', 'sse_bytes', 'time']);
    assert.equal('content' in detail, false);
    assert.equal(detail.duration_ms, 7);
    assert.equal(detail.payload_bytes, 64);
    assert.equal(detail.sse_bytes, 96);
  } finally {
    console.info = originalInfo;
    delete process.env.HERMES_WEB_UI_DEBUG_PERF;
  }
});
