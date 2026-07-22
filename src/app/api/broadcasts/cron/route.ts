import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { drainDueBroadcasts } from '@/lib/whatsapp/broadcast-schedule'

/**
 * Send broadcasts whose scheduled time has arrived. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires the same
 * `x-cron-secret` / `AUTOMATION_CRON_SECRET` pair as the automations
 * drain, so operators configure one secret, not two.
 *
 * Claiming happens inside `drainDueBroadcasts` (a conditional UPDATE
 * from 'scheduled' to 'sending'), so overlapping invocations are safe.
 *
 * Fanning out a full broadcast is slower than draining an automation
 * step, so this route asks for more headroom than the platform
 * default; the per-invocation limit keeps one tick bounded.
 */
export const maxDuration = 300

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await drainDueBroadcasts(supabaseAdmin())

  // `failures` names the broadcasts that could not be sent and why —
  // without it a "0 processed" tick is indistinguishable from a quiet
  // one, which is exactly when an operator needs the detail.
  return NextResponse.json(result)
}
