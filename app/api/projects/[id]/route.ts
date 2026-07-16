import { NextResponse } from 'next/server';
import { deleteProject, updateProject } from '@/lib/store';
import { JSON_BODY_GENERAL_LIMIT_BYTES, jsonBodyErrorResponse, parseJsonBody } from '@/lib/request-body';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = await parseJsonBody(request, JSON_BODY_GENERAL_LIMIT_BYTES);
  if (!parsed.ok) return jsonBodyErrorResponse(parsed);
  const body = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : {};
  try {
    const project = await updateProject(id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      system_prompt: typeof body.system_prompt === 'string' ? body.system_prompt : undefined,
    });
    return NextResponse.json(project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes('not found') ? 404 : 400 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(await deleteProject(id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes('not found') ? 404 : 400 });
  }
}
