'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { revokeCurrentSession } from '@/lib/auth-session'

export function LogoutButton({ className = '', disabled = false }: { className?: string; disabled?: boolean }) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  async function handleLogout() {
    setSubmitting(true)
    await revokeCurrentSession()
    router.replace('/login?reason=logout')
  }

  return (
    <button
      className={`logout-button ${className}`.trim()}
      type="button"
      onClick={() => void handleLogout()}
      disabled={disabled || submitting}
      title="Logout"
    >
      <LogOut size={16} /> {submitting ? 'Logging out' : 'Logout'}
    </button>
  )
}
