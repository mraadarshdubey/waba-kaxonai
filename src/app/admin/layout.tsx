import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireSuperAdmin } from '@/lib/platform/admin'

// Server-side gate for the whole /admin subtree. The API routes each
// re-check requireSuperAdmin() themselves — this layout exists so a
// non-admin never even sees the panel shell, and so the redirect
// happens before any client JS loads.

export const metadata: Metadata = {
  title: 'Super admin',
  robots: { index: false, follow: false, nocache: true },
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  try {
    await requireSuperAdmin()
  } catch {
    redirect('/dashboard')
  }

  return <div className="min-h-screen bg-background">{children}</div>
}
