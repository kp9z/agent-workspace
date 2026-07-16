import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_DB_NAME = 'agent-workspace.sqlite';
const LEGACY_DB_NAME = 'kira-workspace.sqlite';

let db: Database.Database | undefined;
let dbPath: string | undefined;

export function getDataDir() {
  return process.env.HERMES_WEB_UI_DATA_DIR || path.join(process.cwd(), '.data');
}

function workspaceDbPath(dataDir: string, name: string) {
  return path.join(dataDir, name);
}

export function selectDbPath(dataDir: string, fileExists: (filePath: string) => boolean = existsSync) {
  const canonicalPath = workspaceDbPath(dataDir, DEFAULT_DB_NAME);
  if (fileExists(canonicalPath)) return canonicalPath;
  const legacyPath = workspaceDbPath(dataDir, LEGACY_DB_NAME);
  if (fileExists(legacyPath)) return legacyPath;
  return canonicalPath;
}

export function getDbPath() {
  return selectDbPath(getDataDir());
}

function initialize(database: Database.Database) {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(`
    create table if not exists projects (
      id text primary key,
      name text not null,
      slug text not null unique,
      system_prompt text not null default '',
      created_at text not null,
      updated_at text not null
    );

    create table if not exists sessions (
      id text primary key,
      hermes_session_id text not null,
      project_id text references projects(id) on delete set null,
      title text not null,
      created_at text not null,
      updated_at text not null,
      runtime_id text not null default 'default',
      continuation_strategy text not null default 'full_transcript',
      status text not null,
      last_error text,
      pinned_at text,
      archived_at text,
      message_count integer not null default 0,
      last_user_message_at text,
      sort_at text not null
    );

    create table if not exists messages (
      id text primary key,
      session_id text not null references sessions(id) on delete cascade,
      role text not null,
      content text not null,
      status text not null,
      created_at text not null,
      metadata_json text,
      order_index integer not null,
      unique(session_id, order_index)
    );

    create table if not exists tool_events (
      id text primary key,
      message_id text not null references messages(id) on delete cascade,
      tool_call_id text,
      tool_name text not null,
      phase text not null,
      summary text not null,
      status text,
      output text,
      raw_payload_json text,
      created_at text not null,
      updated_at text
    );

    create table if not exists attachments (
      id text primary key,
      message_id text not null references messages(id) on delete cascade,
      type text not null,
      name text not null,
      mime_type text not null,
      data_url text,
      file_path text,
      size_bytes integer not null
    );

    create table if not exists runs (
      id text primary key,
      session_id text not null references sessions(id) on delete cascade,
      assistant_message_id text not null references messages(id),
      hermes_run_id text,
      status text not null,
      started_at text not null,
      updated_at text not null,
      error text
    );

    create table if not exists queued_turns (
      id text primary key,
      session_id text not null references sessions(id) on delete cascade,
      content text not null,
      attachments_json text not null,
      status text not null,
      created_at text not null,
      updated_at text not null,
      position integer not null default 0,
      error text,
      client_turn_id text
    );

    create table if not exists workspace_activity (
      id text primary key,
      last_interaction_at text not null,
      last_session_id text
    );

    create table if not exists workspace_notifications (
      event_key text primary key,
      session_id text not null references sessions(id) on delete cascade,
      event_type text not null,
      status text not null,
      created_at text not null,
      scheduled_for text,
      sent_at text,
      error text
    );

    create index if not exists idx_sessions_updated_at on sessions(updated_at desc);
    create index if not exists idx_projects_slug on projects(slug);
    create index if not exists idx_messages_session_order on messages(session_id, order_index);
    create index if not exists idx_tool_events_message_created on tool_events(message_id, created_at);
    create index if not exists idx_attachments_message on attachments(message_id);
    create index if not exists idx_runs_session on runs(session_id, updated_at desc);
    create index if not exists idx_queued_turns_status_created on queued_turns(status, position, created_at);
    create index if not exists idx_queued_turns_session on queued_turns(session_id, position, created_at);
  `);
  const sessionColumns = database.prepare('pragma table_info(sessions)').all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === 'project_id')) {
    database.exec('alter table sessions add column project_id text references projects(id) on delete set null');
  }
  if (!sessionColumns.some((column) => column.name === 'pinned_at')) {
    database.exec('alter table sessions add column pinned_at text');
  }
  if (!sessionColumns.some((column) => column.name === 'archived_at')) {
    database.exec('alter table sessions add column archived_at text');
  }
  if (!sessionColumns.some((column) => column.name === 'message_count')) {
    database.exec('alter table sessions add column message_count integer not null default 0');
  }
  if (!sessionColumns.some((column) => column.name === 'last_user_message_at')) {
    database.exec('alter table sessions add column last_user_message_at text');
  }
  if (!sessionColumns.some((column) => column.name === 'sort_at')) {
    database.exec('alter table sessions add column sort_at text');
  }
  const queuedTurnColumns = database.prepare('pragma table_info(queued_turns)').all() as Array<{ name: string }>;
  if (!queuedTurnColumns.some((column) => column.name === 'position')) {
    database.exec('alter table queued_turns add column position integer not null default 0');
    const rows = database.prepare('select id from queued_turns order by created_at asc').all() as Array<{ id: string }>;
    const updatePosition = database.prepare('update queued_turns set position = ? where id = ?');
    database.transaction(() => {
      rows.forEach((row, index) => updatePosition.run(index, row.id));
    })();
  }

  database.transaction(() => {
    database.prepare(`
      update sessions
      set
        message_count = (
          select count(*)
          from messages
          where messages.session_id = sessions.id
        ),
        last_user_message_at = (
          select max(messages.created_at)
          from messages
          where messages.session_id = sessions.id and messages.role = 'user'
        ),
        sort_at = coalesce(
          (
            select max(messages.created_at)
            from messages
            where messages.session_id = sessions.id and messages.role = 'user'
          ),
          sessions.updated_at
        )
    `).run();
    database.prepare(`
      insert into workspace_activity (id, last_interaction_at, last_session_id)
      select 'agent-workspace', last_interaction_at, last_session_id
      from workspace_activity
      where id = 'kenny'
        and not exists (select 1 from workspace_activity where id = 'agent-workspace')
    `).run();
  })();

  database.exec('drop index if exists idx_messages_session_order');
  database.exec('drop index if exists idx_sessions_sort_at');
  database.exec('create index if not exists idx_sessions_sort_at on sessions(sort_at desc, updated_at desc, id desc) where not (status = \'idle\' and message_count = 0 and title in (\'New session\', \'New Kira session\'))');
  database.exec('create index if not exists idx_sessions_project on sessions(project_id, archived_at, pinned_at, sort_at desc)');
  database.exec('create index if not exists idx_sessions_pinned on sessions(pinned_at) where pinned_at is not null');
  database.exec('create index if not exists idx_sessions_archived on sessions(archived_at) where archived_at is not null');
  database.exec('create index if not exists idx_workspace_notifications_session on workspace_notifications(session_id, sent_at desc)');
}

export function getDb() {
  const dataDir = getDataDir();
  const currentDbPath = getDbPath();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!db || dbPath !== currentDbPath) {
    if (db) db.close();
    db = new Database(currentDbPath);
    dbPath = currentDbPath;
    initialize(db);
  }
  return db;
}
