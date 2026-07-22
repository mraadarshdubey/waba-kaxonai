// ============================================================
// Platform (super) admin — auth guard + bootstrap.
//
// Super admins operate the whole install: every account, every
// member roster, approve/suspend, role changes. They are "manage +
// oversight" only — nothing in this module (or the /api/admin routes
// built on it) ever reads conversation or message content.
//
// `platform_admins` has RLS enabled with zero policies, so clients
// can't touch it; all access goes through the service-role client
// behind requireSuperAdmin().
// ============================================================

import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';

export interface SuperAdminContext {
  userId: string;
  email: string;
}

/**
 * Resolve the caller and require platform-admin rights.
 *
 * Bootstrap: when `platform_admins` is EMPTY and the caller's email
 * matches SUPER_ADMIN_EMAIL, the caller is inserted as the first
 * super admin and their own account is activated. Empty-table-only,
 * so the env var stops mattering the moment a first admin exists —
 * changing it later cannot mint another one.
 */
export async function requireSuperAdmin(): Promise<SuperAdminContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError();

  const admin = supabaseAdmin();

  const { data: row } = await admin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (row) return { userId: user.id, email: user.email ?? '' };

  // ---- bootstrap path ----------------------------------------
  const bootstrapEmail = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrapEmail && user.email?.toLowerCase() === bootstrapEmail) {
    const { count } = await admin
      .from('platform_admins')
      .select('user_id', { count: 'exact', head: true });
    if ((count ?? 0) === 0) {
      const { error: insErr } = await admin
        .from('platform_admins')
        .insert({ user_id: user.id, added_by: null });
      if (!insErr) {
        // The operator's own account must never sit in 'pending'.
        await admin
          .from('accounts')
          .update({ status: 'active' })
          .eq('owner_user_id', user.id);
        return { userId: user.id, email: user.email ?? '' };
      }
    }
  }

  throw new ForbiddenError('Super admin access required');
}

/** Non-throwing variant for UI affordances (e.g. showing the /admin link). */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}
