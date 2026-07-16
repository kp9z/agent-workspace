import { validateAttachments } from '@/lib/attachments';
import { getSession } from '@/lib/store';
import { startTurn } from '@/lib/turn-runner';
import type { Attachment } from '@/lib/types';
import { isSmokeTestRequest } from '@/lib/smoke';
import { JSON_BODY_ATTACHMENT_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

const MAX_CLIENT_TURN_ID_LENGTH = 120;

function validateClientTurnId(raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('client_turn_id must be a string');
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CLIENT_TURN_ID_LENGTH) throw new Error(`client_turn_id must be ${MAX_CLIENT_TURN_ID_LENGTH} characters or fewer`);
  return trimmed;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let session = await getSession(id);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
  const parsed = await parseJsonBody(request, JSON_BODY_ATTACHMENT_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  const input = String(body.content || '').trim();
  let clientTurnId: string | undefined;
  try {
    clientTurnId = validateClientTurnId(body.client_turn_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
  let attachments: Attachment[];
  try {
    attachments = validateAttachments(body.attachments);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
  if (!input && attachments.length === 0) return Response.json({ error: 'Message content or attachment is required' }, { status: 400 });

  try {
    const suppressNotifications = body.suppress_notifications === true || isSmokeTestRequest(request.headers);
    const result = await startTurn(id, input, attachments, clientTurnId, { suppressNotifications });
    return Response.json({ accepted: true, ...result }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message.includes('running') ? 409 : 500 });
  }
}
