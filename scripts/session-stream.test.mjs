import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), [
  'session-stream.ts',
]);
const require = createRequire(import.meta.url);
const { getRunningSessionPollMs, ACTIVE_RUNNING_POLL_MS, BACKGROUND_RUNNING_POLL_MS, HIDDEN_RUNNING_POLL_MS } = require(path.join(outDir, 'session-stream.js'));

process.on('exit', cleanup);

test('returns null when there is no running session or the stream is already healthy', () => {
  assert.equal(getRunningSessionPollMs({ hasRunningSession: false, activeRunning: false, documentVisible: true, streamHealth: 'idle' }), null);
  assert.equal(getRunningSessionPollMs({ hasRunningSession: true, activeRunning: true, documentVisible: true, streamHealth: 'healthy' }), null);
  assert.equal(getRunningSessionPollMs({ hasRunningSession: true, activeRunning: true, documentVisible: true, streamHealth: 'connecting' }), null);
});

test('uses the correct poll interval when the stream is unhealthy', () => {
  assert.equal(getRunningSessionPollMs({ hasRunningSession: true, activeRunning: true, documentVisible: true, streamHealth: 'error' }), ACTIVE_RUNNING_POLL_MS);
  assert.equal(getRunningSessionPollMs({ hasRunningSession: true, activeRunning: false, documentVisible: true, streamHealth: 'disconnected' }), BACKGROUND_RUNNING_POLL_MS);
  assert.equal(getRunningSessionPollMs({ hasRunningSession: true, activeRunning: true, documentVisible: false, streamHealth: 'error' }), HIDDEN_RUNNING_POLL_MS);
});
