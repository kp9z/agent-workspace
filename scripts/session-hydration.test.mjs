import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-session-hydration-'));
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
]);
const tempNodeModules = path.join(outDir, 'node_modules');
mkdirSync(tempNodeModules, { recursive: true });
symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');
const require = createRequire(import.meta.url);
const { createPendingTurn, createSession, getSession, updateAssistantTurn } = require(path.join(outDir, 'lib/store.js'));
const { getDb } = require(path.join(outDir, 'lib/db.js'));

process.on('exit', cleanup);

function attachmentDataUrl(bytes) {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('session hydration batches tool event and attachment queries and omits persisted base64', async () => {
  try {
    const session = await createSession();
    const firstTurn = await createPendingTurn(session.id, 'turn one', [{ id: 'att-1', type: 'image', name: 'one.png', mime_type: 'image/png', data_url: attachmentDataUrl(pngSignature), size_bytes: pngSignature.length }]);
    await updateAssistantTurn(session.id, firstTurn.assistantMessage.id, {
      content: 'assistant one',
      status: 'complete',
      toolEvents: [
        { id: 'tool-1', tool_name: 'skill_view', phase: 'complete', summary: 'loaded skill', created_at: firstTurn.assistantMessage.created_at },
      ],
    });

    const secondTurn = await createPendingTurn(session.id, 'turn two', [{ id: 'att-2', type: 'image', name: 'two.png', mime_type: 'image/png', data_url: attachmentDataUrl(pngSignature), size_bytes: pngSignature.length }]);
    await updateAssistantTurn(session.id, secondTurn.assistantMessage.id, {
      content: 'assistant two',
      status: 'complete',
      toolEvents: [
        { id: 'tool-2', tool_name: 'skill_view', phase: 'complete', summary: 'loaded skill again', created_at: secondTurn.assistantMessage.created_at },
      ],
    });

    const db = getDb();
    const originalPrepare = db.prepare.bind(db);
    const sqls = [];
    Object.defineProperty(db, 'prepare', {
      configurable: true,
      value: function (sql) {
        sqls.push(String(sql));
        return originalPrepare(sql);
      },
    });

    try {
      const hydrated = await getSession(session.id);
      assert.ok(hydrated);
      const userAttachments = hydrated.messages.flatMap((message) => message.attachments || []);
      assert.equal(userAttachments.length, 2);
      for (const attachment of userAttachments) {
        assert.ok(attachment.url?.startsWith('/api/sessions/'));
        assert.equal(attachment.data_url, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(attachment, 'data_url'), false);
      }
      assert.equal(JSON.stringify(hydrated).includes('data:image/'), false);
      assert.equal(sqls.some((sql) => /from tool_events where message_id = \?/i.test(sql)), false);
      assert.equal(sqls.some((sql) => /from attachments where message_id = \?/i.test(sql)), false);
      assert.ok(sqls.some((sql) => /from tool_events where message_id in \(/i.test(sql)));
      assert.ok(sqls.some((sql) => /from attachments where message_id in \(/i.test(sql)));
      assert.ok(sqls.filter((sql) => /from tool_events where message_id in \(/i.test(sql)).length <= 1);
      assert.ok(sqls.filter((sql) => /from attachments where message_id in \(/i.test(sql)).length <= 1);
    } finally {
      Object.defineProperty(db, 'prepare', { configurable: true, value: originalPrepare });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
