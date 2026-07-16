import { NextResponse } from 'next/server';
import { archiveSessionsByProject, createSession, forkSession, listSessions } from '@/lib/store';
import { JSON_BODY_GENERAL_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

export async function GET() {
  return NextResponse.json({ sessions: await listSessions() });
}

export async function PATCH(request: Request) {
  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};

  if (body.archived !== true || (!Object.hasOwn(body, 'project_id') && body.scope !== 'projectless')) {
    return NextResponse.json({ error: 'Only scoped archive is supported' }, { status: 400 });
  }

  const projectId = typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null;
  try {
    return NextResponse.json({ sessions: await archiveSessionsByProject(projectId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes('not found') ? 404 : 400 });
  }
}

export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  if (typeof body.fork_from_session_id === 'string' || typeof body.fork_point_message_id === 'string') {
    if (typeof body.fork_from_session_id !== 'string' || typeof body.fork_point_message_id !== 'string') {
      return NextResponse.json({ error: 'fork_from_session_id and fork_point_message_id are required together' }, { status: 400 });
    }
    try {
      return NextResponse.json(await forkSession(body.fork_from_session_id, body.fork_point_message_id), { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('not found') ? 404 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  }
  const projectId = typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null;
  try {
    return NextResponse.json(await createSession(projectId), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes('not found') ? 404 : 400 });
  }
}
