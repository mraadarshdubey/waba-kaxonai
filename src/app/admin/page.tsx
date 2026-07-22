'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  MessageSquare,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ============================================================
// Super admin panel — accounts, approvals, roles, admin roster.
//
// Oversight, not surveillance: everything rendered here is account
// metadata and aggregate counts. There is deliberately no way to open
// an account's conversations or read message content.
// ============================================================

interface AccountRow {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'suspended';
  created_at: string;
  owner_email: string | null;
  member_count: number;
  whatsapp_status: string;
  contacts: number;
  messages: number;
}

interface MemberRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  account_role: 'owner' | 'admin' | 'agent' | 'viewer';
}

interface AdminRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<AccountRow['status'], string> = {
  pending: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  suspended: 'bg-red-500/10 text-red-400 border-red-500/20',
};

export default function AdminPage() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, MemberRow[]>>({});
  const [newAdminEmail, setNewAdminEmail] = useState('');

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        fetch('/api/admin/accounts').then((r) => r.json()),
        fetch('/api/admin/admins').then((r) => r.json()),
      ]);
      if (a.error) throw new Error(a.error);
      setAccounts(a.accounts ?? []);
      setAdmins(s.admins ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(
    () => ({
      total: accounts.length,
      pending: accounts.filter((a) => a.status === 'pending').length,
      active: accounts.filter((a) => a.status === 'active').length,
      suspended: accounts.filter((a) => a.status === 'suspended').length,
      messages: accounts.reduce((sum, a) => sum + a.messages, 0),
    }),
    [accounts],
  );

  async function setStatus(id: string, status: AccountRow['status']) {
    setBusy(id);
    try {
      const res = await fetch(`/api/admin/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      setAccounts((rows) =>
        rows.map((r) => (r.id === id ? { ...r, status } : r)),
      );
      toast.success(
        status === 'active' ? 'Account activated' : `Account ${status}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  async function toggleMembers(id: string) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!members[id]) {
      const res = await fetch(`/api/admin/accounts/${id}`);
      const json = await res.json();
      if (res.ok) {
        setMembers((m) => ({ ...m, [id]: json.members ?? [] }));
      } else {
        toast.error(json.error ?? 'Failed to load members');
      }
    }
  }

  async function changeRole(accountId: string, userId: string, role: string) {
    const res = await fetch(
      `/api/admin/accounts/${accountId}/members/${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      },
    );
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed to change role');
      return;
    }
    setMembers((m) => ({
      ...m,
      [accountId]: (m[accountId] ?? []).map((mem) =>
        mem.user_id === userId
          ? { ...mem, account_role: role as MemberRow['account_role'] }
          : mem,
      ),
    }));
    toast.success('Role updated');
  }

  async function grantAdmin() {
    const email = newAdminEmail.trim();
    if (!email) return;
    const res = await fetch('/api/admin/admins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed');
      return;
    }
    toast.success(`${json.granted} is now a super admin`);
    setNewAdminEmail('');
    void load();
  }

  async function revokeAdmin(userId: string) {
    const res = await fetch('/api/admin/admins', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    const json = await res.json();
    if (!res.ok) {
      toast.error(json.error ?? 'Failed');
      return;
    }
    toast.success('Super admin access revoked');
    void load();
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Super admin
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every account on this installation. Metadata and counts only —
            conversations stay private to their teams.
          </p>
        </div>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Button>
      </div>

      {/* ---- stats ---- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: 'Accounts', value: stats.total, icon: Building2 },
          { label: 'Pending', value: stats.pending, icon: Clock },
          { label: 'Active', value: stats.active, icon: CheckCircle2 },
          { label: 'Suspended', value: stats.suspended, icon: ShieldCheck },
          { label: 'Messages', value: stats.messages, icon: MessageSquare },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-3 p-4">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-lg font-semibold text-foreground">
                  {value.toLocaleString()}
                </p>
                <p className="truncate text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ---- accounts ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            Approve pending signups, suspend misbehaving accounts, and manage
            member roles.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts yet.</p>
          ) : (
            accounts.map((a) => (
              <div key={a.id} className="rounded-lg border border-border">
                <div className="flex flex-wrap items-center gap-3 p-3">
                  <button
                    type="button"
                    onClick={() => void toggleMembers(a.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {expanded === a.id ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {a.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.owner_email ?? 'no owner email'} ·{' '}
                        {new Date(a.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </button>

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {a.member_count}
                    </span>
                    <span>{a.contacts.toLocaleString()} contacts</span>
                    <span>{a.messages.toLocaleString()} msgs</span>
                    <Badge
                      variant="outline"
                      className={
                        a.whatsapp_status === 'connected'
                          ? 'border-emerald-500/20 text-emerald-400'
                          : 'border-border text-muted-foreground'
                      }
                    >
                      WA: {a.whatsapp_status.replace('_', ' ')}
                    </Badge>
                    <Badge variant="outline" className={STATUS_BADGE[a.status]}>
                      {a.status}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-2">
                    {a.status === 'pending' ? (
                      <Button
                        size="sm"
                        onClick={() => void setStatus(a.id, 'active')}
                        disabled={busy === a.id}
                      >
                        {busy === a.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </Button>
                    ) : null}
                    {a.status !== 'suspended' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void setStatus(a.id, 'suspended')}
                        disabled={busy === a.id}
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                      >
                        Suspend
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void setStatus(a.id, 'active')}
                        disabled={busy === a.id}
                      >
                        Reactivate
                      </Button>
                    )}
                  </div>
                </div>

                {expanded === a.id ? (
                  <div className="border-t border-border p-3">
                    {!members[a.id] ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : members[a.id].length === 0 ? (
                      <p className="text-sm text-muted-foreground">No members.</p>
                    ) : (
                      <div className="space-y-2">
                        {members[a.id].map((m) => (
                          <div
                            key={m.user_id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm text-foreground">
                                {m.full_name || m.email || m.user_id}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {m.email}
                              </p>
                            </div>
                            {m.account_role === 'owner' ? (
                              <Badge
                                variant="outline"
                                className="border-amber-500/40 bg-amber-500/10 text-amber-300"
                              >
                                owner
                              </Badge>
                            ) : (
                              <Select
                                value={m.account_role}
                                onValueChange={(v) =>
                                  v && void changeRole(a.id, m.user_id, v)
                                }
                              >
                                <SelectTrigger className="h-8 w-28">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="admin">admin</SelectItem>
                                  <SelectItem value="agent">agent</SelectItem>
                                  <SelectItem value="viewer">viewer</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* ---- super admins ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Super admins</CardTitle>
          <CardDescription>
            Grant by email of an existing user. You cannot revoke yourself, and
            the last super admin cannot be removed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              placeholder="user@example.com"
              value={newAdminEmail}
              onChange={(e) => setNewAdminEmail(e.target.value)}
              className="w-64"
            />
            <Button onClick={() => void grantAdmin()} disabled={!newAdminEmail.trim()}>
              Grant access
            </Button>
          </div>

          <div className="space-y-2">
            {admins.map((s) => (
              <div
                key={s.user_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    {s.full_name || s.email || s.user_id}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    since {new Date(s.created_at).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void revokeAdmin(s.user_id)}
                  className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
