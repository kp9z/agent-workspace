import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { attachmentStorageId } from './attachments';
import { getDataDir, getDb } from './db';
import { publishSessionMessage, publishSessionSnapshot, publishSessionSummary } from './session-events';
import { payloadByteLength, serverPerfMark } from './server-perf';
import type { Attachment, ChatSession, Message, Project, ToolEvent } from './types';

const DEFAULT_TITLE = 'New session';
const LEGACY_DEFAULT_TITLE = 'New Kira session';
const MAX_TITLE_LENGTH = 80;
const AUTO_TITLE_MAX_LENGTH = 48;
const MAX_SUMMARY_WORDS = 5;
const DEFAULT_SESSION_TITLES_SQL = [DEFAULT_TITLE, LEGACY_DEFAULT_TITLE].map((title) => `'${title.replace(/'/g, "''")}'`).join(', ');

export const TITLE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'do',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'the',
  'this',
  'to',
  'we',
  'with',
  'would',
  'you',
]);

export function isDefaultSessionTitle(title: string | null | undefined) {
  const normalized = String(title || '').trim();
  return normalized === DEFAULT_TITLE || normalized === LEGACY_DEFAULT_TITLE;
}

const TITLE_LEADING_VERBS = new Set(['add', 'build', 'check', 'create', 'debug', 'fix', 'help', 'implement', 'make', 'review', 'update']);

const TITLE_ICON_RULES: Array<{ icon: string; pattern: RegExp }> = [
  { icon: '🐛', pattern: /\b(bug|debug|error|fail|issue|regression|traceback)\b/i },
  { icon: '💻', pattern: /\b(api|app|build|code|commit|deploy|feature|github|push|repo|test|ui)\b/i },
  { icon: '✍️', pattern: /\b(article|blog|draft|edit|post|rewrite|write)\b/i },
  { icon: '📅', pattern: /\b(calendar|meeting|plan|schedule|today|tomorrow|week)\b/i },
  { icon: '🔎', pattern: /\b(compare|find|look|research|search|summarize)\b/i },
  { icon: '🏠', pattern: /\b(home|light|sensor|tailscale|wifi)\b/i },
];

export function chooseTitleIcon(text: string) {
  return TITLE_ICON_RULES.find((rule) => rule.pattern.test(text))?.icon || '💬';
}

type SessionRow = Omit<ChatSession, 'messages'>;
type MessageRow = Omit<Message, 'attachments' | 'tool_events' | 'metadata'> & { session_id: string; metadata_json: string | null; order_index: number };
type ToolEventRow = Omit<ToolEvent, 'raw_payload'> & { message_id: string; raw_payload_json: string | null };
type ProjectRow = Project;
type AttachmentRow = Omit<Attachment, 'data_url'> & { message_id: string; data_url: string | null; file_path: string | null };

type SessionSummary = Omit<ChatSession, 'messages'> & { message_count: number };
type SessionSummaryRow = SessionRow & {
  message_count: number;
  last_user_message_at: string | null;
  sort_at: string;
};

function slugifyProjectName(name: string) {
  const slug = name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'project';
}

function uniqueProjectSlug(name: string, projectId?: string) {
  const db = getDb();
  const base = slugifyProjectName(name);
  let slug = base;
  let counter = 2;
  while (true) {
    const existing = db.prepare('select id from projects where slug = ?').get(slug) as { id: string } | undefined;
    if (!existing || existing.id === projectId) return slug;
    slug = `${base}-${counter}`.slice(0, 56);
    counter += 1;
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    system_prompt: row.system_prompt || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listProjects(): Promise<Project[]> {
  const rows = getDb().prepare('select * from projects order by updated_at desc, name asc').all() as ProjectRow[];
  return rows.map(toProject);
}

export async function getProject(id: string): Promise<Project | null> {
  const row = getDb().prepare('select * from projects where id = ?').get(id) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

export async function createProject(input: { name: string; system_prompt?: string }): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw new Error('Project name is required');
  const db = getDb();
  const project = db.transaction(() => {
    const now = new Date().toISOString();
    const id = randomUUID();
    const slug = uniqueProjectSlug(name);
    db.prepare('insert into projects (id, name, slug, system_prompt, created_at, updated_at) values (?, ?, ?, ?, ?, ?)')
      .run(id, name, slug, input.system_prompt || '', now, now);
    return db.prepare('select * from projects where id = ?').get(id) as ProjectRow;
  })();
  return toProject(project);
}

export async function updateProject(id: string, input: { name?: string; system_prompt?: string }): Promise<Project> {
  const db = getDb();
  const project = db.transaction(() => {
    const existing = db.prepare('select * from projects where id = ?').get(id) as ProjectRow | undefined;
    if (!existing) throw new Error('Project not found');
    const name = typeof input.name === 'string' ? input.name.trim() : existing.name;
    if (!name) throw new Error('Project name is required');
    const slug = name === existing.name ? existing.slug : uniqueProjectSlug(name, id);
    const systemPrompt = typeof input.system_prompt === 'string' ? input.system_prompt : existing.system_prompt;
    db.prepare('update projects set name = ?, slug = ?, system_prompt = ?, updated_at = ? where id = ?')
      .run(name, slug, systemPrompt, new Date().toISOString(), id);
    return db.prepare('select * from projects where id = ?').get(id) as ProjectRow;
  })();
  return toProject(project);
}

export async function deleteProject(id: string): Promise<{ deletedProjectId: string; deletedSessionIds: string[] }> {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare('select id from projects where id = ?').get(id) as { id: string } | undefined;
    if (!existing) throw new Error('Project not found');

    const sessionRows = db.prepare('select id from sessions where project_id = ?').all(id) as Array<{ id: string }>;
    const deletedSessionIds = sessionRows.map((row) => row.id);

    if (deletedSessionIds.length > 0) {
      const placeholders = deletedSessionIds.map(() => '?').join(', ');
      const attachmentRows = db.prepare(`
        select attachments.*
        from attachments
        join messages on messages.id = attachments.message_id
        where messages.session_id in (${placeholders})
      `).all(...deletedSessionIds) as AttachmentRow[];
      for (const row of attachmentRows) removeAttachmentFile(row);
      db.prepare(`delete from runs where session_id in (${placeholders})`).run(...deletedSessionIds);
      db.prepare(`delete from queued_turns where session_id in (${placeholders})`).run(...deletedSessionIds);
      db.prepare(`delete from sessions where id in (${placeholders})`).run(...deletedSessionIds);
    }

    db.prepare('delete from projects where id = ?').run(id);
    return { deletedProjectId: id, deletedSessionIds };
  })();
}

function notifySessionChanged(sessionId: string) {
  const session = getSessionSync(sessionId);
  if (session) publishSessionSnapshot(sessionId, session);
}

export function attachmentDir() {
  return path.join(getDataDir(), 'attachments');
}

export function extensionForMimeType(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'bin';
}

function attachmentFileName(attachment: Pick<Attachment, 'id' | 'mime_type'>) {
  return `${attachmentStorageId(attachment.id)}.${extensionForMimeType(attachment.mime_type)}`;
}

export function attachmentFilePath(attachment: Pick<Attachment, 'id' | 'mime_type'>) {
  return path.join(attachmentDir(), attachmentFileName(attachment));
}

export function attachmentUrlForMessage(sessionId: string, messageId: string, attachmentId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export function isSafeAttachmentFilePath(filePath: string) {
  const resolvedDir = path.resolve(attachmentDir());
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) return false;
  if (!existsSync(filePath)) return false;
  try {
    const resolvedRealFile = path.resolve(realpathSync(filePath));
    return resolvedRealFile === resolvedDir || resolvedRealFile.startsWith(`${resolvedDir}${path.sep}`);
  } catch {
    return false;
  }
}

function attachmentBufferFromDataUrl(dataUrl: string) {
  const [, base64 = ''] = dataUrl.split(',', 2);
  return base64 ? Buffer.from(base64, 'base64') : null;
}

function chunkIds(ids: string[], size = 400) {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

function groupRowsByMessageId<T extends { message_id: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.message_id);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(row.message_id, [row]);
    }
  }
  return grouped;
}

function loadCount<T>(grouped: Map<string, T[]>) {
  let count = 0;
  for (const rows of grouped.values()) count += rows.length;
  return count;
}

function attachmentBufferFromRow(row: AttachmentRow) {
  if (row.file_path) {
    if (!isSafeAttachmentFilePath(row.file_path)) return null;
    return readFileSync(row.file_path);
  }
  if (!row.data_url) return null;
  return attachmentBufferFromDataUrl(row.data_url);
}

function writeAttachmentFile(attachment: Attachment) {
  const dataUrl = attachment.data_url;
  if (!dataUrl) return null;
  const [, base64 = ''] = dataUrl.split(',', 2);
  if (!base64) return null;
  const dir = attachmentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = attachmentFilePath(attachment);
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) {
    throw new Error('unsafe attachment file path');
  }
  writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

function dataUrlFromAttachmentFile(row: AttachmentRow) {
  if (row.data_url) return row.data_url;
  if (!row.file_path || !existsSync(row.file_path)) return '';
  return `data:${row.mime_type};base64,${readFileSync(row.file_path).toString('base64')}`;
}

function removeAttachmentFile(row: AttachmentRow) {
  if (!row.file_path || !isSafeAttachmentFilePath(row.file_path)) return;
  try {
    unlinkSync(row.file_path);
  } catch {
    // The DB row is still the source of truth; missing files are handled during hydration.
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringifyJson(value: Record<string, unknown> | undefined) {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function titleWords(input: string) {
  const words = Array.from(input.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu), (match) => match[0])
    .map((word) => word.replace(/^["-']+|["-']+$/g, ''))
    .filter((word) => word && !TITLE_STOP_WORDS.has(word.toLowerCase()));
  let start = 0;
  while (words.length - start > 2 && TITLE_LEADING_VERBS.has(words[start].toLowerCase())) start += 1;
  return start > 0 ? words.slice(start) : words;
}

export function buildTitleSummary(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_TITLE;
  const words = titleWords(trimmed).slice(0, MAX_SUMMARY_WORDS);
  const summaryWords = words.length > 0 ? words : trimmed.split(/\s+/).slice(0, MAX_SUMMARY_WORDS);
  const icon = chooseTitleIcon(summaryWords.join(' '));
  const summary = summaryWords.join(' ').slice(0, AUTO_TITLE_MAX_LENGTH - icon.length - 1).trim();
  return summary ? `${icon} ${summary}` : DEFAULT_TITLE;
}

function buildMessageFromRows(row: MessageRow, toolRows: ToolEventRow[], attachmentRows: AttachmentRow[]): Message {
  const tool_events = toolRows.map((event) => ({
    id: event.id,
    tool_call_id: event.tool_call_id || undefined,
    tool_name: event.tool_name,
    phase: event.phase,
    summary: event.summary,
    status: event.status || undefined,
    output: event.output || undefined,
    created_at: event.created_at,
    updated_at: event.updated_at || undefined,
    raw_payload: parseJsonRecord(event.raw_payload_json),
  })) as ToolEvent[];
  const attachments = attachmentRows.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    mime_type: attachment.mime_type,
    url: attachmentUrlForMessage(row.session_id, row.id, attachment.id),
    size_bytes: attachment.size_bytes,
  })) as Attachment[];
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    created_at: row.created_at,
    metadata: parseJsonRecord(row.metadata_json),
    tool_events: tool_events.length > 0 ? tool_events : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function toMessage(row: MessageRow): Message {
  const db = getDb();
  const toolRows = db.prepare('select * from tool_events where message_id = ? order by created_at asc').all(row.id) as ToolEventRow[];
  const attachmentRows = db.prepare('select * from attachments where message_id = ? order by rowid asc').all(row.id) as AttachmentRow[];
  return buildMessageFromRows(row, toolRows, attachmentRows);
}

function loadToolEventRowsForMessages(messageIds: string[]) {
  const db = getDb();
  const rows: ToolEventRow[] = [];
  for (const batch of chunkIds(messageIds)) {
    const placeholders = batch.map(() => '?').join(', ');
    const batchRows = db.prepare(`select * from tool_events where message_id in (${placeholders}) order by message_id asc, created_at asc, id asc`).all(...batch) as ToolEventRow[];
    rows.push(...batchRows);
  }
  return rows;
}

function loadAttachmentRowsForMessages(messageIds: string[]) {
  const db = getDb();
  const rows: AttachmentRow[] = [];
  for (const batch of chunkIds(messageIds)) {
    const placeholders = batch.map(() => '?').join(', ');
    const batchRows = db.prepare(`select * from attachments where message_id in (${placeholders}) order by message_id asc, rowid asc`).all(...batch) as AttachmentRow[];
    rows.push(...batchRows);
  }
  return rows;
}

function hydrateSession(row: SessionRow): ChatSession {
  const startedAt = performance.now();
  const db = getDb();
  const messageRows = db.prepare('select * from messages where session_id = ? order by order_index asc').all(row.id) as MessageRow[];
  const messageIds = messageRows.map((message) => message.id);
  const toolEventRows = groupRowsByMessageId(loadToolEventRowsForMessages(messageIds));
  const attachmentRows = groupRowsByMessageId(loadAttachmentRowsForMessages(messageIds));
  const session = {
    id: row.id,
    hermes_session_id: row.hermes_session_id,
    project_id: row.project_id || null,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    runtime_id: row.runtime_id,
    continuation_strategy: row.continuation_strategy,
    status: row.status,
    last_error: row.last_error || undefined,
    pinned_at: row.pinned_at || null,
    archived_at: row.archived_at || null,
    messages: messageRows.map((message) => buildMessageFromRows(message, toolEventRows.get(message.id) || [], attachmentRows.get(message.id) || [])),
  };
  serverPerfMark('session:hydrate', {
    duration_ms: Math.round(performance.now() - startedAt),
    message_count: messageRows.length,
    tool_event_count: loadCount(toolEventRows),
    attachment_count: loadCount(attachmentRows),
  });
  return session;
}

function getSessionSync(id: string): ChatSession | null {
  const row = getDb().prepare('select * from sessions where id = ?').get(id) as SessionRow | undefined;
  return row ? hydrateSession(row) : null;
}

function nextOrderIndex(sessionId: string) {
  const row = getDb().prepare('select coalesce(max(order_index), -1) + 1 as next from messages where session_id = ?').get(sessionId) as { next: number };
  return row.next;
}

function insertMessage(sessionId: string, message: Message, orderIndex: number) {
  const db = getDb();
  db.prepare(`
    insert into messages (id, session_id, role, content, status, created_at, metadata_json, order_index)
    values (@id, @session_id, @role, @content, @status, @created_at, @metadata_json, @order_index)
  `).run({
    id: message.id,
    session_id: sessionId,
    role: message.role,
    content: message.content,
    status: message.status,
    created_at: message.created_at,
    metadata_json: stringifyJson(message.metadata),
    order_index: orderIndex,
  });
  replaceAttachments(message.id, message.attachments || []);
  replaceToolEvents(message.id, message.tool_events || []);
}

function replaceToolEvents(messageId: string, toolEvents: ToolEvent[]) {
  const db = getDb();
  db.prepare('delete from tool_events where message_id = ?').run(messageId);
  const insert = db.prepare(`
    insert into tool_events (id, message_id, tool_call_id, tool_name, phase, summary, status, output, raw_payload_json, created_at, updated_at)
    values (@id, @message_id, @tool_call_id, @tool_name, @phase, @summary, @status, @output, @raw_payload_json, @created_at, @updated_at)
  `);
  for (const event of toolEvents) {
    insert.run({
      id: event.id,
      message_id: messageId,
      tool_call_id: event.tool_call_id || null,
      tool_name: event.tool_name,
      phase: event.phase,
      summary: event.summary,
      status: event.status || null,
      output: event.output || null,
      raw_payload_json: event.raw_payload ? JSON.stringify(event.raw_payload) : null,
      created_at: event.created_at,
      updated_at: event.updated_at || null,
    });
  }
}

function replaceAttachments(messageId: string, attachments: Attachment[]) {
  const db = getDb();
  const existingRows = db.prepare('select * from attachments where message_id = ?').all(messageId) as AttachmentRow[];
  for (const row of existingRows) removeAttachmentFile(row);
  db.prepare('delete from attachments where message_id = ?').run(messageId);
  const insert = db.prepare(`
    insert into attachments (id, message_id, type, name, mime_type, data_url, file_path, size_bytes)
    values (@id, @message_id, @type, @name, @mime_type, @data_url, @file_path, @size_bytes)
  `);
  for (const attachment of attachments) {
    const filePath = writeAttachmentFile(attachment);
    insert.run({
      id: attachment.id,
      message_id: messageId,
      type: attachment.type,
      name: attachment.name,
      mime_type: attachment.mime_type,
      data_url: null,
      file_path: filePath,
      size_bytes: attachment.size_bytes,
    });
  }
}

function toSessionSummary(row: SessionSummaryRow): SessionSummary & { sort_at: string } {
  return {
    id: row.id,
    hermes_session_id: row.hermes_session_id,
    project_id: row.project_id || null,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    runtime_id: row.runtime_id,
    continuation_strategy: row.continuation_strategy,
    status: row.status,
    last_error: row.last_error || undefined,
    pinned_at: row.pinned_at || null,
    archived_at: row.archived_at || null,
    message_count: row.message_count,
    sort_at: row.sort_at || row.updated_at,
  };
}

export const LIST_SESSIONS_SQL = `
  select
    sessions.*,
    sessions.message_count,
    sessions.last_user_message_at,
    sessions.sort_at
  from sessions
  where not (status = 'idle' and message_count = 0 and title in (${DEFAULT_SESSION_TITLES_SQL}))
  order by sort_at desc, updated_at desc, id desc
`;

export async function listSessions(): Promise<SessionSummary[]> {
  const startedAt = performance.now();
  const rows = getDb().prepare(LIST_SESSIONS_SQL).all() as SessionSummaryRow[];
  const sessions = rows.map(toSessionSummary).map(({ sort_at: _sortAt, ...session }) => session);
  serverPerfMark('sessions:list', {
    duration_ms: Math.round(performance.now() - startedAt),
    count: sessions.length,
    payload_bytes: payloadByteLength(sessions),
  });
  return sessions;
}

export async function createSession(projectId?: string | null): Promise<ChatSession> {
  const db = getDb();
  const session = db.transaction(() => {
    const now = new Date().toISOString();
    const id = randomUUID();
    const normalizedProjectId = projectId || null;
    if (normalizedProjectId) {
      const project = db.prepare('select id from projects where id = ?').get(normalizedProjectId);
      if (!project) throw new Error('Project not found');
    }
    db.prepare(`
      insert into sessions (id, hermes_session_id, project_id, title, created_at, updated_at, runtime_id, continuation_strategy, status, message_count, last_user_message_at, sort_at)
      values (?, ?, ?, ?, ?, ?, 'default', 'full_transcript', 'idle', 0, null, ?)
    `).run(id, `web_${id}`, normalizedProjectId, DEFAULT_TITLE, now, now, now);
    return getSessionSync(id);
  })();
  if (!session) throw new Error('Could not create session');
  notifySessionChanged(session.id);
  return session;
}

function forkTitle(sourceTitle: string) {
  const base = isDefaultSessionTitle(sourceTitle) || !String(sourceTitle || '').trim() ? 'Chat' : String(sourceTitle).trim();
  const title = `Fork: ${base}`;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trim()}…` : title;
}

function copyAttachmentForFork(messageId: string, attachment: Attachment): Attachment {
  if (attachment.data_url) return { ...attachment, id: randomUUID() };
  const row = getDb().prepare('select * from attachments where id = ? and message_id = ?').get(attachment.id, messageId) as AttachmentRow | undefined;
  if (!row) return { ...attachment, id: randomUUID(), data_url: '' };
  const bytes = attachmentBufferFromRow(row);
  const dataUrl = bytes ? `data:${row.mime_type};base64,${bytes.toString('base64')}` : '';
  return { ...attachment, id: randomUUID(), data_url: dataUrl };
}

function cloneMessageForFork(message: Message, createdAt: string): Message {
  return {
    ...message,
    id: randomUUID(),
    created_at: createdAt,
    metadata: {
      ...(message.metadata || {}),
      forked_from_message_id: message.id,
    },
    attachments: message.attachments?.map((attachment) => copyAttachmentForFork(message.id, attachment)),
    tool_events: message.tool_events?.map((event) => ({ ...event, id: randomUUID(), created_at: createdAt, updated_at: event.updated_at ? createdAt : undefined })),
  };
}

export async function forkSession(sourceSessionId: string, forkPointMessageId: string): Promise<ChatSession> {
  const db = getDb();
  const forked = db.transaction(() => {
    const source = getSessionSync(sourceSessionId);
    if (!source) throw new Error('Source session not found');
    const forkPointIndex = source.messages.findIndex((message) => message.id === forkPointMessageId);
    if (forkPointIndex < 0) throw new Error('Fork point message not found');

    const now = new Date().toISOString();
    const id = randomUUID();
    const forkedMessages = source.messages.slice(0, forkPointIndex + 1).map((message) => cloneMessageForFork(message, now));
    const lastUserMessageAt = [...forkedMessages].reverse().find((message) => message.role === 'user')?.created_at || null;
    db.prepare(`
      insert into sessions (id, hermes_session_id, project_id, title, created_at, updated_at, runtime_id, continuation_strategy, status, message_count, last_user_message_at, sort_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
    `).run(id, `web_${id}`, source.project_id || null, forkTitle(source.title), now, now, source.runtime_id || 'default', source.continuation_strategy || 'full_transcript', forkedMessages.length, lastUserMessageAt, lastUserMessageAt || now);

    forkedMessages.forEach((message, index) => {
      const copy = message.status === 'streaming' || message.status === 'pending' ? { ...message, status: 'complete' as const } : message;
      insertMessage(id, copy, index);
    });

    return getSessionSync(id);
  })();
  if (!forked) throw new Error('Could not create fork');
  notifySessionChanged(forked.id);
  return forked;
}

export async function getSession(id: string): Promise<ChatSession | null> {
  return getSessionSync(id);
}

export async function renameSession(sessionId: string, title: string): Promise<ChatSession> {
  if (typeof title !== 'string') throw new Error('Session title must be a string');
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Session title is required');
  if (trimmed.length > MAX_TITLE_LENGTH) throw new Error(`Session title must be ${MAX_TITLE_LENGTH} characters or fewer`);
  const now = new Date().toISOString();
  const db = getDb();
  const session = db.transaction(() => {
    const result = db.prepare('update sessions set title = ?, updated_at = ?, sort_at = coalesce(last_user_message_at, ?) where id = ?').run(trimmed, now, now, sessionId);
    if (result.changes === 0) throw new Error('Session not found');
    return getSessionSync(sessionId);
  })();
  if (!session) throw new Error('Session not found');
  publishSessionSummary(sessionId, { title: trimmed, updated_at: now });
  return session;
}

export async function updateSessionMetadata(sessionId: string, input: { pinned?: boolean; archived?: boolean }): Promise<ChatSession> {
  const hasPinned = typeof input.pinned === 'boolean';
  const hasArchived = typeof input.archived === 'boolean';
  if (!hasPinned && !hasArchived) throw new Error('No session metadata changes provided');

  const db = getDb();
  const session = db.transaction(() => {
    const existing = db.prepare('select * from sessions where id = ?').get(sessionId) as SessionRow | undefined;
    if (!existing) throw new Error('Session not found');

    const now = new Date().toISOString();
    const pinnedAt = hasArchived && input.archived ? null : hasPinned ? (input.pinned ? (existing.pinned_at || now) : null) : existing.pinned_at || null;
    const archivedAt = hasArchived ? (input.archived ? (existing.archived_at || now) : null) : existing.archived_at || null;

    db.prepare('update sessions set pinned_at = ?, archived_at = ? where id = ?').run(pinnedAt, archivedAt, sessionId);
    return getSessionSync(sessionId);
  })();
  if (!session) throw new Error('Session not found');
  publishSessionSummary(sessionId, { pinned_at: session.pinned_at || null, archived_at: session.archived_at || null });
  return session;
}

export async function archiveSessionsByProject(projectId: string | null): Promise<SessionSummary[]> {
  const db = getDb();
  const changedSessionIds = db.transaction(() => {
    if (projectId) {
      const project = db.prepare('select id from projects where id = ?').get(projectId);
      if (!project) throw new Error('Project not found');
    }

    const rows = projectId
      ? db.prepare('select id from sessions where project_id = ? and archived_at is null').all(projectId) as Array<{ id: string }>
      : db.prepare('select id from sessions where project_id is null and archived_at is null').all() as Array<{ id: string }>;
    if (rows.length === 0) return [];

    if (projectId) {
      db.prepare('update sessions set pinned_at = null, archived_at = ? where project_id = ? and archived_at is null').run(new Date().toISOString(), projectId);
    } else {
      db.prepare('update sessions set pinned_at = null, archived_at = ? where project_id is null and archived_at is null').run(new Date().toISOString());
    }
    return rows.map((row) => row.id);
  })();

  for (const sessionId of changedSessionIds) notifySessionChanged(sessionId);
  return listSessions();
}

export async function appendTurn(
  sessionId: string,
  input: string,
  attachments: Attachment[],
  assistant: string,
  toolEvents: ToolEvent[],
  failed?: string,
): Promise<Message> {
  const db = getDb();
  const message = db.transaction(() => {
    const session = getSessionSync(sessionId);
    if (!session) throw new Error('Session not found');
    const now = new Date().toISOString();
    const orderIndex = nextOrderIndex(sessionId);
    const userMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: input,
      status: 'complete',
      created_at: now,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    const assistantMessage: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: assistant,
      status: failed ? 'failed' : 'complete',
      created_at: now,
      tool_events: toolEvents,
      metadata: {
        continuation_strategy: session.continuation_strategy || 'full_transcript',
        continuation_backend: 'not_used',
        continuation_id_state: 'unavailable',
        error: failed || undefined,
      },
    };
    insertMessage(sessionId, userMessage, orderIndex);
    insertMessage(sessionId, assistantMessage, orderIndex + 1);
    const title = isDefaultSessionTitle(session.title) && input.trim() ? buildTitleSummary(input) : session.title;
    db.prepare('update sessions set title = ?, updated_at = ?, status = ?, last_error = ?, message_count = message_count + 2, last_user_message_at = ?, sort_at = ? where id = ?').run(
      title,
      assistantMessage.created_at,
      failed ? 'failed' : 'idle',
      failed || null,
      userMessage.created_at,
      userMessage.created_at,
      sessionId,
    );
    return getDb().prepare('select * from messages where id = ?').get(assistantMessage.id) as MessageRow;
  })();
  notifySessionChanged(sessionId);
  return toMessage(message);
}

type PendingTurnResult = {
  userMessage: Message;
  assistantMessage: Message;
  created: boolean;
  title?: string;
  updatedAt?: string;
  messageCount?: number;
};

export async function createPendingTurn(
  sessionId: string,
  input: string,
  attachments: Attachment[],
  clientTurnId?: string,
): Promise<PendingTurnResult> {
  const db = getDb();
  const result = db.transaction((): PendingTurnResult => {
    const session = getSessionSync(sessionId);
    if (!session) throw new Error('Session not found');
    if (clientTurnId) {
      const existingAssistantIndex = session.messages.findIndex(
        (message) => message.role === 'assistant' && message.metadata?.client_turn_id === clientTurnId,
      );
      if (existingAssistantIndex > 0) {
        const existingUser = session.messages[existingAssistantIndex - 1];
        const existingAssistant = session.messages[existingAssistantIndex];
        if (existingUser?.role === 'user') return { userMessage: existingUser, assistantMessage: existingAssistant, created: false };
      }
    }
    if (session.status === 'running') throw new Error('Session already has a running turn');
    const now = new Date().toISOString();
    const orderIndex = nextOrderIndex(sessionId);
    const userMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: input,
      status: 'complete',
      created_at: now,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: clientTurnId ? { client_turn_id: clientTurnId } : undefined,
    };
    const assistantMessage: Message = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      status: 'streaming',
      created_at: now,
      tool_events: [],
      metadata: {
        continuation_strategy: session.continuation_strategy || 'full_transcript',
        continuation_backend: 'not_used',
        continuation_id_state: 'unavailable',
        client_turn_id: clientTurnId,
      },
    };
    insertMessage(sessionId, userMessage, orderIndex);
    insertMessage(sessionId, assistantMessage, orderIndex + 1);
    const title = isDefaultSessionTitle(session.title) && input.trim() ? buildTitleSummary(input) : session.title;
    const updatedAt = assistantMessage.created_at;
    db.prepare('update sessions set title = ?, updated_at = ?, status = ?, last_error = null, message_count = message_count + 2, last_user_message_at = ?, sort_at = ? where id = ?').run(
      title,
      updatedAt,
      'running',
      userMessage.created_at,
      userMessage.created_at,
      sessionId,
    );
    return { userMessage, assistantMessage, created: true, title, updatedAt, messageCount: session.messages.length + 2 };
  })();
  if (result.created) {
    publishSessionMessage(sessionId, result.userMessage);
    publishSessionMessage(sessionId, result.assistantMessage);
    publishSessionSummary(sessionId, { title: result.title || '', status: 'running', updated_at: result.updatedAt || result.assistantMessage.created_at, last_error: null, message_count: result.messageCount || 0 });
  }
  return result;
}

export async function setSessionTitleIfDefault(sessionId: string, title: string): Promise<boolean> {
  return setSessionTitleIfDefaultOr(sessionId, title);
}

export async function setSessionTitleIfDefaultOr(sessionId: string, title: string, allowedCurrentTitle?: string): Promise<boolean> {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!trimmed || isDefaultSessionTitle(trimmed)) return false;
  const allowedTitles = [DEFAULT_TITLE, LEGACY_DEFAULT_TITLE];
  const allowed = allowedCurrentTitle?.trim().slice(0, MAX_TITLE_LENGTH);
  if (allowed && !allowedTitles.includes(allowed)) allowedTitles.push(allowed);
  const placeholders = allowedTitles.map(() => '?').join(', ');
  const updatedAt = new Date().toISOString();
  const result = getDb()
    .prepare(`update sessions set title = ?, updated_at = ?, sort_at = coalesce(last_user_message_at, ?) where id = ? and title in (${placeholders})`)
    .run(trimmed, updatedAt, updatedAt, sessionId, ...allowedTitles);
  if (result.changes > 0) publishSessionSummary(sessionId, { title: trimmed, updated_at: updatedAt });
  return result.changes > 0;
}

export async function updateAssistantTurn(
  sessionId: string,
  messageId: string,
  update: { content?: string; toolEvents?: ToolEvent[]; status?: Message['status']; error?: string },
): Promise<Message> {
  const db = getDb();
  const message = db.transaction(() => {
    const row = db.prepare('select * from messages where id = ? and session_id = ?').get(messageId, sessionId) as MessageRow | undefined;
    if (!row) throw new Error('Assistant message not found');
    if (row.role !== 'assistant') throw new Error('Message is not an assistant turn');
    const metadata = { ...(parseJsonRecord(row.metadata_json) || {}), error: update.error || undefined };
    const content = update.content ?? row.content;
    const status = update.status ?? row.status;
    const now = new Date().toISOString();
    db.prepare('update messages set content = ?, status = ?, metadata_json = ? where id = ?').run(content, status, stringifyJson(metadata), messageId);
    if (update.toolEvents !== undefined) replaceToolEvents(messageId, update.toolEvents);
    if (update.status === 'complete') {
      db.prepare('update sessions set updated_at = ?, status = ?, last_error = null, sort_at = coalesce(last_user_message_at, ?) where id = ?').run(now, 'idle', now, sessionId);
    } else if (update.status === 'failed') {
      db.prepare('update sessions set updated_at = ?, status = ?, last_error = ?, sort_at = coalesce(last_user_message_at, ?) where id = ?').run(now, 'failed', update.error || null, now, sessionId);
    } else {
      db.prepare('update sessions set updated_at = ?, sort_at = coalesce(last_user_message_at, ?) where id = ?').run(now, now, sessionId);
    }
    return {
      id: row.id,
      role: row.role,
      content,
      status,
      created_at: row.created_at,
      metadata,
      tool_events: update.toolEvents,
      updated_at: now,
    } as Message & { updated_at: string };
  })() as Message & { updated_at: string };
  publishSessionMessage(sessionId, {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    created_at: message.created_at,
    metadata: message.metadata,
    tool_events: message.tool_events,
    updated_at: message.updated_at,
  });
  if (update.status === 'complete') {
    publishSessionSummary(sessionId, { status: 'idle', updated_at: message.updated_at, last_error: null });
  } else if (update.status === 'failed') {
    publishSessionSummary(sessionId, { status: 'failed', updated_at: message.updated_at, last_error: update.error || null });
  } else {
    publishSessionSummary(sessionId, { updated_at: message.updated_at });
  }
  return message;
}

export async function updateSessionStatus(sessionId: string, status: ChatSession['status'], error?: string) {
  const updatedAt = new Date().toISOString();
  const result = getDb().prepare('update sessions set status = ?, last_error = ?, updated_at = ?, sort_at = coalesce(last_user_message_at, ?) where id = ?').run(
    status,
    error || null,
    updatedAt,
    updatedAt,
    sessionId,
  );
  if (result.changes === 0) throw new Error('Session not found');
  publishSessionSummary(sessionId, { status, last_error: error || null, updated_at: updatedAt });
}

export async function failRunningTurn(sessionId: string, error: string): Promise<ChatSession | null> {
  const db = getDb();
  let updatedAt = '';
  const session = db.transaction(() => {
    const session = getSessionSync(sessionId);
    if (!session) return null;
    const assistant = [...session.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'streaming');
    updatedAt = new Date().toISOString();
    if (assistant) {
      const metadata = { ...(assistant.metadata || {}), error };
      db.prepare('update messages set status = ?, content = case when content = ? then ? else content end, metadata_json = ? where id = ?').run(
        'failed',
        '',
        error,
        stringifyJson(metadata),
        assistant.id,
      );
    }
    db.prepare('update sessions set status = ?, last_error = ?, updated_at = ?, sort_at = coalesce(last_user_message_at, ?) where id = ?').run('failed', error, updatedAt, updatedAt, sessionId);
    return getSessionSync(sessionId);
  })();
  if (session) {
    publishSessionSummary(sessionId, { status: 'failed', last_error: error, updated_at: updatedAt || session.updated_at });
    const assistant = [...session.messages].reverse().find((message) => message.role === 'assistant' && message.status === 'failed');
    if (assistant) {
      publishSessionMessage(sessionId, {
        id: assistant.id,
        role: assistant.role,
        content: assistant.content,
        status: assistant.status,
        created_at: assistant.created_at,
        metadata: assistant.metadata,
        tool_events: assistant.tool_events,
        updated_at: updatedAt || session.updated_at,
      });
    }
  }
  return session;
}
