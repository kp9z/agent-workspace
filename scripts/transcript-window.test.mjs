import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), ['transcript-window.ts']);
const require = createRequire(import.meta.url);
const { getTranscriptWindow, DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD, DEFAULT_TRANSCRIPT_WINDOW_SIZE, transcriptMessageCount } = require(path.join(outDir, 'transcript-window.js'));

process.on('exit', cleanup);

function messages(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}` }));
}

test('transcript window keeps the full list below the collapse threshold', () => {
  const window = getTranscriptWindow(messages(DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD), {
    collapseThreshold: DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD,
    windowSize: DEFAULT_TRANSCRIPT_WINDOW_SIZE,
  });

  assert.equal(window.isCollapsed, false);
  assert.equal(window.hiddenMessageCount, 0);
  assert.deepEqual(window.visibleMessages.map((message) => message.id), messages(DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD).map((message) => message.id));
});

test('transcript window collapses only when explicitly requested or above threshold and still reveals older messages on demand', () => {
  const full = messages(DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD + 5);
  const collapsed = getTranscriptWindow(full, {
    collapsed: true,
    collapseThreshold: DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD,
    windowSize: 3,
  });
  assert.equal(collapsed.isCollapsed, true);
  assert.equal(collapsed.hiddenMessageCount, full.length - 3);
  assert.deepEqual(collapsed.visibleMessages.map((message) => message.id), ['m123', 'm124', 'm125']);

  const revealed = getTranscriptWindow(full, {
    collapsed: false,
    collapseThreshold: DEFAULT_TRANSCRIPT_COLLAPSE_THRESHOLD,
    windowSize: 3,
  });
  assert.equal(revealed.isCollapsed, false);
  assert.equal(revealed.hiddenMessageCount, 0);
  assert.deepEqual(revealed.visibleMessages.map((message) => message.id), full.map((message) => message.id));
  assert.equal(transcriptMessageCount(revealed.visibleMessages, null), full.length);
});
