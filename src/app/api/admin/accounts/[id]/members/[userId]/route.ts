import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { toErrorResponse } from '@/lib/auth/account'

// Super admin: change a member's role inside any account.
//
// Ownership is intentionally NOT transferable here — the in-app
// transfer flow (Settings → Members) runs through RPCs that keep
// accounts.owner_user_id and profiles.account_role consistent.
// Letting this endpoint write 'owner' would bypass those invariants
// and desync the two, so it caps at admin.

const ASSIGNABLE = ['admin', 'agent', 'viewer'] as const

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id, userId } = await params
  const body = await request.json().catch(() => null)
  const role = body?.role
  if (!ASSIGNABLE.includes(role)) {
    return NextResponse.json(
      { error: "role must be 'admin', 'agent', or 'viewer'" },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  const { data: profile } = await admin
    .from('profiles')
    .select('user_id, account_id, account_role')
    .eq('user_id', userId)
    .eq('account_id', id)
    .maybeSingle()
  if (!profile) {
    return NextResponse.json(
      { error: 'That user is not a member of this account' },
      { status: 404 },
    )
  }
  if (profile.account_role === 'owner') {
    return NextResponse.json(
      {
        error:
          "The owner's role cannot be changed here — use the in-app ownership transfer instead.",
      },
      { status: 400 },
    )
  }

  const { data: updated, error } = await admin
    .from('profiles')
    .update({ account_role: role })
    .eq('user_id', userId)
    .eq('account_id', id)
    .select('user_id, email, account_role')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ member: updated })
}
