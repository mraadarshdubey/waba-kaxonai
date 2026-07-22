"use client";

import { useEffect, useState } from "react";
import { Clock, ShieldAlert, LogOut, RefreshCw } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

// Full-screen gate for accounts that are not active.
//
// Enforcement is server-side (is_account_member requires an active
// account, so RLS returns nothing and API routes 403) — without this
// component a pending user would just see an eerily empty dashboard.
// This turns that into an honest explanation.
//
// 'unknown' (status fetch failed / no profile row) renders the app
// rather than a scare screen: enforcement doesn't depend on this
// component, so failing open here only risks showing empty UI, while
// failing closed would lock out real users on a transient fetch error.

type GateState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "pending"; accountName: string | null }
  | { kind: "suspended"; accountName: string | null };

async function fetchGateState(): Promise<GateState> {
  try {
    const res = await fetch("/api/account/status");
    if (!res.ok) return { kind: "ok" };
    const json = await res.json();
    const status = json.account_status as string | null;
    if (status === "pending") {
      return { kind: "pending", accountName: json.account_name ?? null };
    }
    if (status === "suspended") {
      return { kind: "suspended", accountName: json.account_name ?? null };
    }
    return { kind: "ok" };
  } catch {
    return { kind: "ok" };
  }
}

export function AccountStatusGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "loading" });

  async function check() {
    setState(await fetchGateState());
  }

  useEffect(() => {
    let cancelled = false;
    void fetchGateState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (state.kind === "ok") return <>{children}</>;

  const isPending = state.kind === "pending";

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          {isPending ? (
            <Clock className="h-6 w-6 text-primary" />
          ) : (
            <ShieldAlert className="h-6 w-6 text-red-400" />
          )}
        </div>

        <h1 className="text-lg font-semibold text-foreground">
          {isPending ? "Waiting for approval" : "Account suspended"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {isPending ? (
            <>
              Your account{state.accountName ? ` "${state.accountName}" ` : " "}
              has been created and is waiting for an administrator to approve
              it. You&apos;ll be able to use the app as soon as that happens.
            </>
          ) : (
            <>
              Your account{state.accountName ? ` "${state.accountName}" ` : " "}
              has been suspended by an administrator. If you believe this is a
              mistake, contact the person who runs this installation.
            </>
          )}
        </p>

        <div className="mt-6 flex justify-center gap-2">
          {isPending ? (
            <Button variant="outline" onClick={() => void check()}>
              <RefreshCw className="h-4 w-4" />
              Check again
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={async () => {
              await createClient().auth.signOut();
              window.location.href = "/login";
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
