import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-session-events-'));
  process.env.HERMES_WEB_UI_DATA_DIR = dataDir;

  try {
    // @ts-expect-error Node's strip-types runtime needs the .ts extension here.
    const { createPendingTurn, createSession, updateAssistantTurn } = await import('../lib/store.ts');
    // @ts-expect-error Node's strip-types runtime needs the .ts extension here.
    const { sessionEventName, subscribeToSession } = await import('../lib/session-events.ts');

    const session = await createSession();
    const events: Array<Awaited<ReturnType<typeof captureEvent>>> = [];

    function captureEvent(event: Parameters<Parameters<typeof subscribeToSession>[1]>[0]) {
      return event;
    }

    const unsubscribe = subscribeToSession(session.id, (event) => {
      events.push(captureEvent(event));
    });

    const pending = await createPendingTurn(session.id, 'streaming assistant update', []);
    assert.equal(pending.created, true);
    events.length = 0;

    const assistantUpdate = await updateAssistantTurn(session.id, pending.assistantMessage.id, {
      content: 'streamed chunk',
      status: 'streaming',
    });

    assert.equal(assistantUpdate.status, 'streaming');
    assert.equal(events.length, 2);

    const [messageEvent, summaryEvent] = events;
    assert.equal(sessionEventName(messageEvent), 'session-message');
    assert.equal(sessionEventName(summaryEvent), 'session-summary');
    assert.equal(messageEvent.type, 'message');
    assert.equal(summaryEvent.type, 'summary');
    assert.equal(messageEvent.session_id, session.id);
    assert.equal(summaryEvent.session_id, session.id);
    assert.equal(messageEvent.message.id, pending.assistantMessage.id);
    assert.equal(messageEvent.message.content, 'streamed chunk');
    assert.equal(messageEvent.message.status, 'streaming');
    assert.equal(messageEvent.message.attachments, undefined);
    assert.equal((messageEvent as { session?: unknown }).session, undefined);
    assert.equal((summaryEvent as { session?: unknown }).session, undefined);
    assert.equal((summaryEvent as { patch: { updated_at?: string } }).patch.updated_at, messageEvent.message.updated_at);
    assert.ok(messageEvent.message.updated_at);
    assert.ok(!JSON.stringify(messageEvent).includes('"messages"'));
    assert.ok(!JSON.stringify(messageEvent).includes('"attachments"'));

    unsubscribe();
    console.log('session event publishing test passed');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
