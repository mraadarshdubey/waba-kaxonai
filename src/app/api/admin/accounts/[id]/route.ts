import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { toErrorResponse } from '@/lib/auth/account'

// Super admin: one account's detail (member roster + metadata), and
// status transitions (approve / suspend / reactivate).

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const admin = supabaseAdmin()

  const { data: account, error } = await admin
    .from('accounts')
    .select('id, name, status, owner_user_id, default_currency, created_at')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  const { data: members } = await admin
    .from('profiles')
    .select('user_id, email, full_name, account_role, created_at')
    .eq('account_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json({ account, members: members ?? [] })
}

const TRANSITIONS: Record<string, string[]> = {
  // from -> allowed to
  pending: ['active', 'suspended'],
  active: ['suspended'],
  suspended: ['active'],
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  const nextStatus = body?.status
  if (!['pending', 'active', 'suspended'].includes(nextStatus)) {
    return NextResponse.json(
      { error: "status must be 'pending', 'active', or 'suspended'" },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  const { data: account } = await admin
    .from('accounts')
    .select('id, status, owner_user_id')
    .eq('id', id)
    .maybeSingle()
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  // A super admin suspending their own account would lock them out of
  // the very panel they'd need to undo it (their session survives, but
  // it's a foot-gun with no upside).
  if (account.owner_user_id === ctx.userId && nextStatus !== 'active') {
    return NextResponse.json(
      { error: 'You cannot suspend your own account' },
      { status: 400 },
    )
  }

  const allowed = TRANSITIONS[account.status as string] ?? []
  if (account.status !== nextStatus && !allowed.includes(nextStatus)) {
    return NextResponse.json(
      { error: `Cannot move an account from '${account.status}' to '${nextStatus}'` },
      { status: 409 },
    )
  }

  const { data: updated, error } = await admin
    .from('accounts')
    .update({ status: nextStatus })
    .eq('id', id)
    .select('id, name, status')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ account: updated })
}
