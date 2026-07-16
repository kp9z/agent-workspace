import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-title-abort-'));
process.env.HERMES_WEB_UI_DATA_DIR = dataDir;

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(rootDir, [
  'lib/db.ts',
  'lib/types.ts',
  'lib/session-events.ts',
  'lib/tool-events.ts',
  'lib/workspace-env.ts',
  'lib/server-perf.ts',
  'lib/attachments.ts',
  'lib/store.ts',
  'lib/title-generator.ts',
]);
const tempNodeModules = path.join(outDir, 'node_modules');
mkdirSync(tempNodeModules, { recursive: true });
symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');

const require = createRequire(import.meta.url);
const { autoTitleSessionFromFirstMessage, isTitleGenerationAbort } = require(path.join(outDir, 'lib/title-generator.js'));

process.on('exit', cleanup);

test('title generation AbortError stays quiet and never retries', async () => {
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const originalDebug = console.debug;
  const warnCalls = [];
  const debugCalls = [];
  let fetchCalls = 0;

  global.fetch = async () => {
    fetchCalls += 1;
    throw new DOMException('The operation was aborted.', 'AbortError');
  };
  console.warn = (...args) => { warnCalls.push(args); };
  console.debug = (...args) => { debugCalls.push(args); };

  try {
    assert.equal(isTitleGenerationAbort(new DOMException('stop', 'AbortError')), true);
    assert.equal(isTitleGenerationAbort(new Error('nope')), false);

    autoTitleSessionFromFirstMessage('session-title-abort', 'Please title this session');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(fetchCalls, 1);
    assert.equal(warnCalls.length, 0);
    assert.equal(debugCalls.length, 0);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    console.debug = originalDebug;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
