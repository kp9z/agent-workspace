import { recordWorkspaceInteraction } from '@/lib/notifications';
import { JSON_BODY_GENERAL_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

export async function POST(request: Request) {
  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  recordWorkspaceInteraction(sessionId);
  return Response.json({ ok: true });
}
