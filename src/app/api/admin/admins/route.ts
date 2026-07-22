import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { toErrorResponse } from '@/lib/auth/account'

// Super admin roster: list, grant, revoke. Grant is by email of an
// EXISTING user — super admin is a promotion, not an invitation.

export async function GET() {
  try {
    await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: rows, error } = await admin
    .from('platform_admins')
    .select('user_id, added_by, created_at')
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const ids = (rows ?? []).map((r) => r.user_id as string)
  const { data: profiles } = ids.length
    ? await admin
        .from('profiles')
        .select('user_id, email, full_name')
        .in('user_id', ids)
    : { data: [] }

  const byId = new Map(
    (profiles ?? []).map((p) => [p.user_id as string, p]),
  )

  return NextResponse.json({
    admins: (rows ?? []).map((r) => ({
      user_id: r.user_id,
      created_at: r.created_at,
      email: byId.get(r.user_id as string)?.email ?? null,
      full_name: byId.get(r.user_id as string)?.full_name ?? null,
    })),
  })
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const email =
    typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const { data: profile } = await admin
    .from('profiles')
    .select('user_id, email')
    .ilike('email', email)
    .maybeSingle()
  if (!profile) {
    return NextResponse.json(
      { error: 'No user with that email — they must sign up first' },
      { status: 404 },
    )
  }

  const { error } = await admin
    .from('platform_admins')
    .upsert(
      { user_id: profile.user_id, added_by: ctx.userId },
      { onConflict: 'user_id', ignoreDuplicates: true },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ granted: profile.email }, { status: 201 })
}

export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const userId = typeof body?.user_id === 'string' ? body.user_id : ''
  if (!userId) {
    return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
  }

  // Lockout guards: you cannot revoke yourself, and the install must
  // always keep at least one super admin.
  if (userId === ctx.userId) {
    return NextResponse.json(
      { error: 'You cannot revoke your own super admin access' },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()
  const { count } = await admin
    .from('platform_admins')
    .select('user_id', { count: 'exact', head: true })
  if ((count ?? 0) <= 1) {
    return NextResponse.json(
      { error: 'Cannot remove the last super admin' },
      { status: 400 },
    )
  }

  const { error } = await admin
    .from('platform_admins')
    .delete()
    .eq('user_id', userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ revoked: userId })
}
