import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isSuperAdmin } from '@/lib/platform/admin'

// Self status — the one endpoint that still answers when the caller's
// account is pending or suspended (everything else dies at RLS /
// getCurrentAccount). The client uses it to decide between the
// "waiting for approval" screen, the "suspended" screen, and the app,
// and whether to show the Super Admin link.
//
// Reads go through the service role because a non-owner member of a
// pending account cannot see the account row at all under RLS, yet
// still deserves an accurate screen.

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: profile } = await admin
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()

  let accountStatus: string | null = null
  let accountName: string | null = null
  if (profile?.account_id) {
    const { data: account } = await admin
      .from('accounts')
      .select('name, status')
      .eq('id', profile.account_id)
      .maybeSingle()
    accountStatus = (account?.status as string) ?? null
    accountName = (account?.name as string) ?? null
  }

  return NextResponse.json({
    account_status: accountStatus,
    account_name: accountName,
    is_super_admin: await isSuperAdmin(user.id),
  })
}
