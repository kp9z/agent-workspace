import { NextResponse } from 'next/server';
import { runtimeHealth } from '@/lib/hermes';

export async function GET() {
  const info = await runtimeHealth();
  return NextResponse.json(info, { status: info.status === 'ok' ? 200 : 503 });
}
