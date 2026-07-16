import { validateAttachments } from '@/lib/attachments';
import { deleteQueuedTurn, drainQueuedTurns, enqueueQueuedTurn, listQueuedTurns, reorderQueuedTurns } from '@/lib/server-queue';
import { getSession } from '@/lib/store';
import type { Attachment } from '@/lib/types';
import { JSON_BODY_ATTACHMENT_LIMIT_BYTES, JSON_BODY_GENERAL_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

export async function GET() {
  return Response.json({ queue: listQueuedTurns() });
}

export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, JSON_BODY_ATTACHMENT_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  const sessionId = String(body.session_id || '').trim();
  if (!sessionId) return Response.json({ error: 'session_id is required' }, { status: 400 });
  const session = await getSession(sessionId);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
  const content = String(body.content || '').trim();
  let attachments: Attachment[];
  try {
    attachments = validateAttachments(body.attachments);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
  if (!content && attachments.length === 0) return Response.json({ error: 'Message content or attachment is required' }, { status: 400 });
  try {
    enqueueQueuedTurn(sessionId, content, attachments);
    drainQueuedTurns().catch((error) => console.error('Agent Workspace queue drain failed', error));
    return Response.json({ queue: listQueuedTurns() }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = String(searchParams.get('id') || '').trim();
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
  deleteQueuedTurn(id);
  drainQueuedTurns().catch((error) => console.error('Agent Workspace queue drain failed', error));
  return Response.json({ queue: listQueuedTurns() });
}

export async function PATCH(request: Request) {
  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  const sessionId = String(body.session_id || '').trim();
  const orderedIds = Array.isArray(body.ordered_ids) ? body.ordered_ids.map((id: unknown) => String(id).trim()).filter(Boolean) : [];
  if (!sessionId) return Response.json({ error: 'session_id is required' }, { status: 400 });
  if (orderedIds.length === 0) return Response.json({ error: 'ordered_ids is required' }, { status: 400 });
  reorderQueuedTurns(sessionId, orderedIds);
  drainQueuedTurns().catch((error) => console.error('Agent Workspace queue drain failed', error));
  return Response.json({ queue: listQueuedTurns() });
}
