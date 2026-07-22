import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { cancelScheduledBroadcast } from '@/lib/whatsapp/broadcast-schedule'

/**
 * Cancel a queued broadcast before its scheduled time.
 *
 * Only broadcasts still in 'scheduled' can be cancelled — once the
 * cron drain has claimed one, messages are already going out and the
 * broadcast must keep its real outcome. That check lives in
 * `cancelScheduledBroadcast` as a conditional UPDATE, so a cancel that
 * races the drain loses cleanly instead of mislabelling a live send.
 *
 * Uses the caller's RLS-scoped client rather than the service role:
 * the broadcasts policy already restricts rows to the caller's
 * account, so a wrong id from another tenant simply matches nothing.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  if (!id) {
    return NextResponse.json({ error: 'Broadcast id is required' }, { status: 400 })
  }

  const cancelled = await cancelScheduledBroadcast(ctx.supabase, id)
  if (!cancelled) {
    return NextResponse.json(
      {
        error:
          'This broadcast is no longer scheduled — it may have already started sending, or it does not exist.',
      },
      { status: 409 },
    )
  }

  return NextResponse.json({ id, status: 'cancelled' })
}
