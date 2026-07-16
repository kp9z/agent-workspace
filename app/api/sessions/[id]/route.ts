import { NextResponse } from 'next/server';
import { failRunningTurn, getSession, renameSession, updateSessionMetadata } from '@/lib/store';
import { runningTurns } from '@/lib/run-registry';
import { JSON_BODY_GENERAL_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

const MAX_TITLE_LENGTH = 80;
const RUNNING_TURN_GRACE_MS = 5_000;

function runningTurnStartedAt(session: Awaited<ReturnType<typeof getSession>>) {
  const streamingAssistant = [...session?.messages || []].reverse().find((message) => message.role === 'assistant' && message.status === 'streaming');
  return streamingAssistant?.created_at || session?.updated_at || null;
}

function isRunningTurnStale(session: NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  const startedAt = runningTurnStartedAt(session);
  if (!startedAt) return true;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return true;
  return Date.now() - startedMs > RUNNING_TURN_GRACE_MS;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (session.status === 'running' && !runningTurns.has(id) && isRunningTurnStale(session)) {
    session = (await failRunningTurn(id, 'Previous run was interrupted after the browser/server connection was lost. Please send the message again.')) ?? session;
  }
  return NextResponse.json(session);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  const hasTitle = Object.hasOwn(body, 'title');
  const hasPinned = Object.hasOwn(body, 'pinned');
  const hasArchived = Object.hasOwn(body, 'archived');

  try {
    if (hasTitle) {
      if (typeof body.title !== 'string') {
        return NextResponse.json({ error: 'Session title must be a string' }, { status: 400 });
      }
      const title = body.title.trim();
      if (!title) return NextResponse.json({ error: 'Session title is required' }, { status: 400 });
      if (title.length > MAX_TITLE_LENGTH) {
        return NextResponse.json({ error: `Session title must be ${MAX_TITLE_LENGTH} characters or fewer` }, { status: 400 });
      }
      return NextResponse.json(await renameSession(id, title));
    }

    if (hasPinned || hasArchived) {
      if (hasPinned && typeof body.pinned !== 'boolean') {
        return NextResponse.json({ error: 'Session pinned must be a boolean' }, { status: 400 });
      }
      if (hasArchived && typeof body.archived !== 'boolean') {
        return NextResponse.json({ error: 'Session archived must be a boolean' }, { status: 400 });
      }
      const pinned = hasPinned ? (body.pinned as boolean) : undefined;
      const archived = hasArchived ? (body.archived as boolean) : undefined;
      return NextResponse.json(await updateSessionMetadata(id, { pinned, archived }));
    }

    return NextResponse.json({ error: 'No supported session changes provided' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'Session not found' ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
