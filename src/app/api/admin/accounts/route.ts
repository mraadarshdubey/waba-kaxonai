import { NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { toErrorResponse } from '@/lib/auth/account'

// Super admin: list every account with owner, member count, and
// aggregate usage counts. Metadata and counts only — conversation and
// message CONTENT is deliberately never selected anywhere under
// /api/admin (oversight, not surveillance).

export async function GET() {
  try {
    await requireSuperAdmin()
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()

  const { data: accounts, error } = await admin
    .from('accounts')
    .select('id, name, status, owner_user_id, default_currency, created_at')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = accounts ?? []
  const ids = rows.map((a) => a.id as string)

  // One grouped pass per dimension instead of N queries per account.
  const [profiles, waConfigs] = await Promise.all([
    admin
      .from('profiles')
      .select('account_id, user_id, email, full_name, account_role'),
    ids.length
      ? admin
          .from('whatsapp_config')
          .select('account_id, status')
          .in('account_id', ids)
      : Promise.resolve({ data: [] as { account_id: string; status: string }[] }),
  ])

  const membersByAccount = new Map<string, number>()
  const ownerEmail = new Map<string, string>()
  for (const p of profiles.data ?? []) {
    const acct = p.account_id as string
    membersByAccount.set(acct, (membersByAccount.get(acct) ?? 0) + 1)
    if (p.account_role === 'owner') {
      ownerEmail.set(acct, (p.email as string) ?? '')
    }
  }

  const waByAccount = new Map<string, string>()
  for (const w of waConfigs.data ?? []) {
    waByAccount.set(w.account_id as string, w.status as string)
  }

  // Per-account usage counts. head:true count queries are cheap, but
  // still bound the fan-out so a huge install can't stall the panel.
  const usage = new Map<string, { contacts: number; messages: number }>()
  await Promise.all(
    ids.slice(0, 100).map(async (id) => {
      const [c, m] = await Promise.all([
        admin
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', id),
        admin
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', id),
      ])
      usage.set(id, { contacts: c.count ?? 0, messages: m.count ?? 0 })
    })
  )

  return NextResponse.json({
    accounts: rows.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      created_at: a.created_at,
      owner_email: ownerEmail.get(a.id as string) ?? null,
      member_count: membersByAccount.get(a.id as string) ?? 0,
      whatsapp_status: waByAccount.get(a.id as string) ?? 'not_configured',
      contacts: usage.get(a.id as string)?.contacts ?? 0,
      messages: usage.get(a.id as string)?.messages ?? 0,
    })),
  })
}
