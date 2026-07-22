import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  DEFAULT_AWAY_MESSAGE,
  normalizeBusinessHoursRow,
  normalizeHolidays,
  normalizeSchedule,
} from '@/lib/business-hours/config'
import { isOpenAt, describeNextOpen } from '@/lib/business-hours/schedule'

// Business hours + away message. GET returns the account's settings
// (any member — the inbox shows an "outside hours" badge to everyone)
// along with a computed `open_now` so the client doesn't have to
// reimplement the schedule evaluator. PUT upserts, admin only.
//
// Mirrors the quick-replies route: RLS-scoped read via the user
// client, service-role write behind an explicit role check.

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    // RLS (business_hours_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('business_hours')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const settings = normalizeBusinessHoursRow(data)
    const now = new Date()

    return NextResponse.json({
      // `null` row means the account never configured it — the client
      // renders the defaults and only creates a row on first save.
      business_hours: data ?? null,
      settings,
      open_now: isOpenAt(settings, now),
      next_open: describeNextOpen(settings, now),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function PUT(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : 'UTC'
  if (!isValidTimeZone(timezone)) {
    return NextResponse.json(
      { error: `Unknown timezone: ${timezone}` },
      { status: 400 },
    )
  }

  const awayMessage =
    typeof body.away_message === 'string' && body.away_message.trim()
      ? body.away_message.trim()
      : DEFAULT_AWAY_MESSAGE
  if (awayMessage.length > 1024) {
    // WhatsApp caps a text body at 4096, but an away message that long
    // is a mistake — fail loudly rather than truncating on send.
    return NextResponse.json(
      { error: 'away_message must be 1024 characters or fewer' },
      { status: 400 },
    )
  }

  const throttleRaw = Number(body.away_throttle_minutes)
  const throttle =
    Number.isFinite(throttleRaw) && throttleRaw >= 0
      ? Math.min(Math.floor(throttleRaw), 60 * 24 * 7)
      : 240

  // Normalising before the write means the row can never hold a shape
  // the evaluator would silently drop — what you save is what runs.
  const payload = {
    account_id: ctx.accountId,
    enabled: body.enabled === true,
    timezone,
    schedule: normalizeSchedule(body.schedule),
    holidays: normalizeHolidays(body.holidays),
    away_message_enabled: body.away_message_enabled !== false,
    away_message: awayMessage,
    away_throttle_minutes: throttle,
    pause_automations: body.pause_automations === true,
    pause_ai_autoreply: body.pause_ai_autoreply === true,
  }

  const { data, error } = await supabaseAdmin()
    .from('business_hours')
    .upsert(payload, { onConflict: 'account_id' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const settings = normalizeBusinessHoursRow(data)
  const now = new Date()

  return NextResponse.json({
    business_hours: data,
    settings,
    open_now: isOpenAt(settings, now),
    next_open: describeNextOpen(settings, now),
  })
}
