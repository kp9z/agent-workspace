import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { getSession } from '@/lib/store';
import { runningTurns } from '@/lib/run-registry';
import { startTurn } from '@/lib/turn-runner';
import type { Attachment } from '@/lib/types';

export type QueuedTurn = {
  id: string;
  sessionId: string;
  content: string;
  attachments: Attachment[];
  status: 'queued' | 'sending' | 'failed';
  createdAt: string;
  updatedAt: string;
  error?: string;
  clientTurnId: string;
};

type QueuedTurnRow = {
  id: string;
  session_id: string;
  content: string;
  attachments_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  position: number;
  error?: string | null;
  client_turn_id?: string | null;
};

const MAX_QUEUED_TURNS_PER_SESSION = 10;
let draining = false;

function parseAttachments(value: string): Attachment[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    return [];
  }
}

function toQueuedTurn(row: QueuedTurnRow): QueuedTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    attachments: parseAttachments(row.attachments_json),
    status: row.status === 'sending' || row.status === 'failed' ? row.status : 'queued',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error || undefined,
    clientTurnId: row.client_turn_id || row.id,
  };
}

export function listQueuedTurns(sessionId?: string): QueuedTurn[] {
  const db = getDb();
  const rows = sessionId
    ? db.prepare('select * from queued_turns where session_id = ? order by position asc, created_at asc').all(sessionId)
    : db.prepare('select * from queued_turns order by position asc, created_at asc').all();
  return (rows as QueuedTurnRow[]).map(toQueuedTurn);
}

export function enqueueQueuedTurn(sessionId: string, content: string, attachments: Attachment[]): QueuedTurn {
  const db = getDb();
  const count = db.prepare("select count(*) as count from queued_turns where session_id = ? and status in ('queued', 'sending')").get(sessionId) as { count: number };
  if (count.count >= MAX_QUEUED_TURNS_PER_SESSION) throw new Error(`Queue is full (${MAX_QUEUED_TURNS_PER_SESSION} messages max).`);
  const nextPosition = db.prepare('select coalesce(max(position), -1) + 1 as position from queued_turns').get() as { position: number };
  const now = new Date().toISOString();
  const id = randomUUID();
  const clientTurnId = `queue-${id}`;
  db.prepare(`
    insert into queued_turns (id, session_id, content, attachments_json, status, created_at, updated_at, position, error, client_turn_id)
    values (?, ?, ?, ?, 'queued', ?, ?, ?, null, ?)
  `).run(id, sessionId, content, JSON.stringify(attachments), now, now, nextPosition.position, clientTurnId);
  return toQueuedTurn(db.prepare('select * from queued_turns where id = ?').get(id) as QueuedTurnRow);
}

export function deleteQueuedTurn(id: string) {
  getDb().prepare('delete from queued_turns where id = ?').run(id);
}

export function reorderQueuedTurns(sessionId: string, orderedIds: string[]) {
  const db = getDb();
  const existingRows = db.prepare('select id, position from queued_turns where session_id = ? order by position asc, created_at asc').all(sessionId) as Array<{ id: string; position: number }>;
  const existingIds = existingRows.map((row) => row.id);
  const existingSet = new Set(existingIds);
  const nextIds = orderedIds.filter((id, index) => existingSet.has(id) && orderedIds.indexOf(id) === index);
  for (const id of existingIds) {
    if (!nextIds.includes(id)) nextIds.push(id);
  }
  const reusablePositions = existingRows.map((row) => row.position).sort((a, b) => a - b);
  const now = new Date().toISOString();
  const updatePosition = db.prepare('update queued_turns set position = ?, updated_at = ? where id = ? and session_id = ?');
  db.transaction(() => {
    nextIds.forEach((id, index) => updatePosition.run(reusablePositions[index], now, id, sessionId));
  })();
}

function markFailed(id: string, error: string) {
  getDb().prepare("update queued_turns set status = 'failed', error = ?, updated_at = ? where id = ?").run(error, new Date().toISOString(), id);
}

function markQueued(id: string) {
  getDb().prepare("update queued_turns set status = 'queued', error = null, updated_at = ? where id = ?").run(new Date().toISOString(), id);
}

function claimNextQueuedTurn(): QueuedTurn | null {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare("select * from queued_turns where status = 'queued' order by position asc, created_at asc").all() as QueuedTurnRow[];
    for (const row of rows) {
      const session = db.prepare('select status from sessions where id = ?').get(row.session_id) as { status: string } | undefined;
      if (!session || runningTurns.has(row.session_id)) continue;
      const result = db.prepare("update queued_turns set status = 'sending', updated_at = ? where id = ? and status = 'queued'").run(new Date().toISOString(), row.id);
      if (result.changes > 0) return toQueuedTurn({ ...row, status: 'sending' });
    }
    return null;
  })();
}

export async function drainQueuedTurns() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const queued = claimNextQueuedTurn();
      if (!queued) return;
      try {
        const session = await getSession(queued.sessionId);
        if (!session) {
          deleteQueuedTurn(queued.id);
          continue;
        }
        if (runningTurns.has(queued.sessionId)) {
          markQueued(queued.id);
          continue;
        }
        await startTurn(queued.sessionId, queued.content, queued.attachments, queued.clientTurnId);
        deleteQueuedTurn(queued.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('running turn') || message.includes('already has a running')) {
          markQueued(queued.id);
        } else {
          markFailed(queued.id, message);
        }
      }
    }
  } finally {
    draining = false;
  }
}
