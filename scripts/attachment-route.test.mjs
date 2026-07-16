import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-attachment-route-'));
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
  'app/api/sessions/[id]/messages/[messageId]/attachments/[attachmentId]/route.ts',
]);
const tempNodeModules = path.join(outDir, 'node_modules');
mkdirSync(tempNodeModules, { recursive: true });
symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');
const aliasRoot = path.join(tempNodeModules, '@');
mkdirSync(aliasRoot, { recursive: true });
symlinkSync(path.join(outDir, 'lib'), path.join(aliasRoot, 'lib'), 'dir');

const require = createRequire(import.meta.url);
const { createPendingTurn, createSession, updateAssistantTurn } = require(path.join(outDir, 'lib/store.js'));
const { getDb } = require(path.join(outDir, 'lib/db.js'));
const { GET: getAttachment } = require(path.join(outDir, 'app/api/sessions/[id]/messages/[messageId]/attachments/[attachmentId]/route.js'));

process.on('exit', cleanup);

function attachmentDataUrl(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('attachment route serves persisted bytes, rejects mismatched ownership, and blocks unsafe file paths', async () => {
  try {
    const session = await createSession();
    const pending = await createPendingTurn(session.id, 'attached turn', [{ id: 'att-route', type: 'image', name: 'route.png', mime_type: 'image/png', data_url: attachmentDataUrl(pngSignature), size_bytes: pngSignature.length }]);
    await updateAssistantTurn(session.id, pending.assistantMessage.id, { content: 'done', status: 'complete' });

    const attachment = pending.userMessage.attachments?.[0];
    assert.ok(attachment);

    const okResponse = await getAttachment(new Request('http://127.0.0.1'), {
      params: Promise.resolve({ id: session.id, messageId: pending.userMessage.id, attachmentId: attachment.id }),
    });
    assert.equal(okResponse.status, 200);
    assert.equal(okResponse.headers.get('content-type'), 'image/png');
    assert.equal(okResponse.headers.get('cache-control'), 'private, no-store, max-age=0, must-revalidate');
    assert.equal(okResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(okResponse.headers.get('content-disposition')?.includes('inline'));
    const body = Buffer.from(await okResponse.arrayBuffer());
    assert.deepEqual(body, pngSignature);

    const missingResponse = await getAttachment(new Request('http://127.0.0.1'), {
      params: Promise.resolve({ id: session.id, messageId: pending.userMessage.id, attachmentId: 'missing-attachment' }),
    });
    assert.equal(missingResponse.status, 404);

    const mismatchedOwnershipResponse = await getAttachment(new Request('http://127.0.0.1'), {
      params: Promise.resolve({ id: session.id, messageId: 'wrong-message', attachmentId: attachment.id }),
    });
    assert.equal(mismatchedOwnershipResponse.status, 404);

    const db = getDb();
    db.prepare('update attachments set file_path = ?, data_url = ? where id = ?').run('/etc/passwd', attachmentDataUrl(pngSignature), attachment.id);
    const unsafeResponse = await getAttachment(new Request('http://127.0.0.1'), {
      params: Promise.resolve({ id: session.id, messageId: pending.userMessage.id, attachmentId: attachment.id }),
    });
    assert.equal(unsafeResponse.status, 404);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
