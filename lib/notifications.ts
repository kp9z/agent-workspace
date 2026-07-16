import { createHmac } from 'crypto';

import { getDb } from './db';
import { getSession } from './store';
import { getWorkspaceBaseUrl, getWorkspaceNotificationInactivityMs, getWorkspaceNotificationSessionRateLimitMs } from './workspace-env';

const ACTIVITY_ID = 'agent-workspace';
const DEFAULT_INACTIVITY_MS = 60_000;
const DEFAULT_SESSION_RATE_LIMIT_MS = 60_000;

type NotificationEventType = 'approval_needed' | 'run_failed' | 'run_succeeded';

type AttentionNotification = {
  type: NotificationEventType;
  sessionId: string;
  eventKey: string;
};

type ActivityRow = {
  id: string;
  last_interaction_at: string;
  last_session_id: string | null;
};

type NotificationRow = {
  event_key: string;
  session_id: string;
  event_type: NotificationEventType;
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  created_at: string;
  scheduled_for: string | null;
  sent_at: string | null;
  error: string | null;
};

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function nowIso() {
  return new Date().toISOString();
}

function inactivityMs() {
  return getWorkspaceNotificationInactivityMs(DEFAULT_INACTIVITY_MS);
}

function sessionRateLimitMs() {
  return getWorkspaceNotificationSessionRateLimitMs(DEFAULT_SESSION_RATE_LIMIT_MS);
}

function envFlagEnabled(name: string) {
  return process.env[name] === 'true' || process.env[name] === '1';
}

function notificationsEnabled() {
  return envFlagEnabled('HERMES_NOTIFY_ENABLED');
}

function runSuccessNotificationsEnabled() {
  return envFlagEnabled('HERMES_NOTIFY_RUN_SUCCESS_ENABLED');
}

function workspaceBaseUrl() {
  return getWorkspaceBaseUrl();
}

function webhookUrl() {
  return process.env.HERMES_NOTIFY_WEBHOOK_URL || '';
}

function webhookSecret() {
  return process.env.HERMES_NOTIFY_WEBHOOK_SECRET || '';
}

function markdownEscape(value: string) {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function chatUrl(sessionId: string) {
  const base = workspaceBaseUrl();
  if (!base) return '';
  const url = new URL(base);
  url.searchParams.set('session', sessionId);
  return url.toString();
}

function latestActivity(): ActivityRow | null {
  return getDb().prepare('select * from workspace_activity where id = ?').get(ACTIVITY_ID) as ActivityRow | undefined || null;
}

function msSinceLastInteraction() {
  const row = latestActivity();
  if (!row) return Number.POSITIVE_INFINITY;
  const then = Date.parse(row.last_interaction_at);
  return Number.isFinite(then) ? Date.now() - then : Number.POSITIVE_INFINITY;
}

function upsertNotification(event: AttentionNotification, scheduledFor: string | null) {
  const db = getDb();
  const existing = db.prepare('select * from workspace_notifications where event_key = ?').get(event.eventKey) as NotificationRow | undefined;
  if (existing) return existing;
  const createdAt = nowIso();
  db.prepare(`
    insert into workspace_notifications (event_key, session_id, event_type, status, created_at, scheduled_for)
    values (?, ?, ?, 'pending', ?, ?)
  `).run(event.eventKey, event.sessionId, event.type, createdAt, scheduledFor);
  return db.prepare('select * from workspace_notifications where event_key = ?').get(event.eventKey) as NotificationRow;
}

function markNotification(eventKey: string, status: NotificationRow['status'], error?: string) {
  getDb().prepare(`
    update workspace_notifications
    set status = ?, sent_at = case when ? = 'sent' then ? else sent_at end, error = ?
    where event_key = ?
  `).run(status, status, nowIso(), error || null, eventKey);
}

function recentlyNotifiedSession(sessionId: string, eventKey: string) {
  const row = getDb().prepare(`
    select sent_at from workspace_notifications
    where session_id = ? and event_key <> ? and status = 'sent' and sent_at is not null
    order by sent_at desc
    limit 1
  `).get(sessionId, eventKey) as { sent_at: string } | undefined;
  if (!row?.sent_at) return false;
  const sentAt = Date.parse(row.sent_at);
  return Number.isFinite(sentAt) && Date.now() - sentAt < sessionRateLimitMs();
}

function hasUserReplyAfterCompletedAssistant(event: AttentionNotification) {
  if (event.type !== 'run_succeeded') return false;
  const assistantMessageId = event.eventKey.replace(/^run_succeeded:/, '');
  if (!assistantMessageId || assistantMessageId === event.eventKey) return false;
  const assistantMessage = getDb().prepare(`
    select order_index from messages
    where id = ? and session_id = ? and role = 'assistant'
  `).get(assistantMessageId, event.sessionId) as { order_index: number } | undefined;
  if (!assistantMessage) return false;
  const userReply = getDb().prepare(`
    select id from messages
    where session_id = ? and role = 'user' and order_index > ?
    limit 1
  `).get(event.sessionId, assistantMessage.order_index) as { id: string } | undefined;
  return Boolean(userReply);
}

async function postToHermesRuntime(sessionId: string) {
  const url = webhookUrl();
  if (!url) throw new Error('HERMES_NOTIFY_WEBHOOK_URL is not configured');
  const session = await getSession(sessionId);
  if (!session) throw new Error('Session not found');
  const link = chatUrl(sessionId);
  const title = session.title || 'Agent Workspace chat';
  const text = link ? `New message from [${markdownEscape(title)}](${link})` : `New message from ${title}`;
  const body = JSON.stringify({
    text,
    title,
    url: link,
    session_id: sessionId,
    source: 'agent-workspace',
  });
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  const secret = webhookSecret();
  if (secret) {
    headers['X-Webhook-Signature'] = createHmac('sha256', secret).update(body).digest('hex');
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`Hermes notify webhook returned ${response.status}: ${await response.text()}`);
  }
}

async function maybeSend(event: AttentionNotification) {
  pendingTimers.delete(event.eventKey);
  const row = getDb().prepare('select * from workspace_notifications where event_key = ?').get(event.eventKey) as NotificationRow | undefined;
  if (!row || row.status !== 'pending') return;
  const inactiveFor = msSinceLastInteraction();
  const waitMs = inactivityMs() - inactiveFor;
  if (waitMs > 0) {
    scheduleTimer(event, waitMs);
    return;
  }
  if (hasUserReplyAfterCompletedAssistant(event)) {
    markNotification(event.eventKey, 'skipped', 'user replied');
    return;
  }
  if (recentlyNotifiedSession(event.sessionId, event.eventKey)) {
    markNotification(event.eventKey, 'skipped', 'session rate-limited');
    return;
  }
  if (!notificationsEnabled()) {
    markNotification(event.eventKey, 'skipped', 'notifications disabled');
    return;
  }
  try {
    await postToHermesRuntime(event.sessionId);
    markNotification(event.eventKey, 'sent');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Agent Workspace notification failed', message);
    markNotification(event.eventKey, 'failed', message);
  }
}

function scheduleTimer(event: AttentionNotification, waitMs: number) {
  const existing = pendingTimers.get(event.eventKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    maybeSend(event).catch((error) => console.error('Agent Workspace delayed notification failed', error));
  }, Math.max(0, waitMs));
  pendingTimers.set(event.eventKey, timer);
}

export function recordWorkspaceInteraction(sessionId?: string | null) {
  const now = nowIso();
  getDb().prepare(`
    insert into workspace_activity (id, last_interaction_at, last_session_id)
    values (?, ?, ?)
    on conflict(id) do update set last_interaction_at = excluded.last_interaction_at, last_session_id = coalesce(excluded.last_session_id, workspace_activity.last_session_id)
  `).run(ACTIVITY_ID, now, sessionId || null);
}

export function queueAttentionNotification(event: AttentionNotification) {
  if (event.type === 'run_succeeded' && !runSuccessNotificationsEnabled()) return;
  const inactiveFor = msSinceLastInteraction();
  const waitMs = Math.max(0, inactivityMs() - inactiveFor);
  const scheduledFor = waitMs > 0 ? new Date(Date.now() + waitMs).toISOString() : nowIso();
  const row = upsertNotification(event, scheduledFor);
  if (row.status !== 'pending') return;
  scheduleTimer(event, waitMs);
}
