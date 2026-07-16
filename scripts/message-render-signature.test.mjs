import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), ['message-render-signature.ts']);
const require = createRequire(import.meta.url);
const { messageRenderSignature } = require(path.join(outDir, 'message-render-signature.js'));

process.on('exit', cleanup);

test('messageRenderSignature stays stable for unchanged render inputs', () => {
  const message = {
    id: 'message-1',
    role: 'assistant',
    status: 'complete',
    created_at: '2025-01-01T00:00:00.000Z',
    content: 'hello world',
    attachments: [{ id: 'attach-1', type: 'image', name: 'shot.png', mime_type: 'image/png', url: '/shot.png', size_bytes: 10 }],
    tool_events: [{ id: 'tool-1', tool_name: 'search', phase: 'complete', summary: 'done', status: 'ok', output: 'ok', created_at: '2025-01-01T00:00:01.000Z' }],
    metadata: { render_version: 3 },
  };

  const copy = structuredClone(message);
  assert.equal(messageRenderSignature(message), messageRenderSignature(copy));
});

test('messageRenderSignature changes when visible render inputs change, including same-length attachment/tool-event edits', () => {
  const base = {
    id: 'message-1',
    role: 'assistant',
    status: 'complete',
    created_at: '2025-01-01T00:00:00.000Z',
    content: 'hello world',
    attachments: [{ id: 'attach-1', type: 'image', name: 'shot.png', mime_type: 'image/png', url: '/shot.png', size_bytes: 10 }],
    tool_events: [{ id: 'tool-1', tool_name: 'search', phase: 'complete', summary: 'done', status: 'ok', output: 'ok', created_at: '2025-01-01T00:00:01.000Z' }],
    metadata: { render_version: 3 },
  };

  assert.notEqual(messageRenderSignature(base), messageRenderSignature({ ...base, content: 'hello universe' }));
  assert.notEqual(messageRenderSignature(base), messageRenderSignature({ ...base, attachments: [{ ...base.attachments[0], name: 'different.png' }] }));
  assert.notEqual(messageRenderSignature(base), messageRenderSignature({ ...base, tool_events: [{ ...base.tool_events[0], summary: 'different' }] }));
  assert.notEqual(messageRenderSignature(base), messageRenderSignature({ ...base, metadata: { render_version: 4 } }));
});
