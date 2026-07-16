import { NextResponse } from 'next/server';
import { runningTurns } from '@/lib/run-registry';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const runningTurn = runningTurns.get(id);
  if (!runningTurn) {
    return NextResponse.json({ stopped: false, error: 'No running turn for this session' }, { status: 409 });
  }
  runningTurn.controller.abort();
  await Promise.race([
    runningTurn.promise.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  return NextResponse.json({ stopped: true, assistant_message_id: runningTurn.assistant_message_id });
}
