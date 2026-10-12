'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef } from 'react'
import { API_BASE_URL } from '@/lib/api'
import {
  AUTH_TOKEN_STORAGE_KEY,
  INACTIVITY_TIMEOUT_MS,
  clearAuthSession,
  isAuthTimedOut,
  markAuthActivity,
  readAuthToken,
  readLastAuthActivity,
} from '@/lib/auth-storage'
import { revokeCurrentSession } from '@/lib/auth-session'

const activityEvents = ['keydown', 'pointerdown', 'pointermove', 'scroll', 'touchstart'] as const
const activityWriteThrottleMs = 1000
const serverTouchThrottleMs = 60 * 1000
const timeoutCheckIntervalMs = 5000

export function AuthSessionManager() {
  const pathname = usePathname()
  const router = useRouter()
  const lastActivityWriteRef = useRef(0)
  const lastServerTouchRef = useRef(0)
  const touchInFlightRef = useRef(false)
  const isLoginRoute = pathname?.startsWith('/login') ?? false

  const redirectToLogin = useCallback(
    (reason?: string) => {
      const suffix = reason ? `?reason=${encodeURIComponent(reason)}` : ''
      router.replace(`/login${suffix}`)
    },
    [router],
  )

  const logout = useCallback(
    async (reason: string) => {
      await revokeCurrentSession()
      redirectToLogin(reason)
    },
    [redirectToLogin],
  )

  const touchServerSession = useCallback(
    async (force = false) => {
      const token = readAuthToken()
      if (!token) return false

      const now = Date.now()
      if (!force && now - lastServerTouchRef.current < serverTouchThrottleMs) return true
      if (touchInFlightRef.current) return true

      lastServerTouchRef.current = now
      touchInFlightRef.current = true

      try {
        const response = await fetch(`${API_BASE_URL}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (response.status === 401) {
          clearAuthSession()
          redirectToLogin('session-expired')
          return false
        }

        return response.ok
      } catch {
        return true
      } finally {
        touchInFlightRef.current = false
      }
    },
    [redirectToLogin],
  )

  const enforceTimeout = useCallback(() => {
    if (isLoginRoute) return false

    const token = readAuthToken()
    if (!token) {
      redirectToLogin()
      return false
    }

    const lastActivity = readLastAuthActivity()
    if (!lastActivity) {
      markAuthActivity()
      void touchServerSession(true)
      return true
    }

    if (Date.now() - lastActivity >= INACTIVITY_TIMEOUT_MS) {
      void logout('inactive')
      return false
    }

    return true
  }, [isLoginRoute, logout, redirectToLogin, touchServerSession])

  useEffect(() => {
    if (isLoginRoute) return

    const token = readAuthToken()
    if (!token) {
      redirectToLogin()
      return
    }

    if (isAuthTimedOut()) {
      void logout('inactive')
      return
    }

    if (!readLastAuthActivity()) markAuthActivity()
    void touchServerSession(true)
  }, [isLoginRoute, logout, pathname, redirectToLogin, touchServerSession])

  useEffect(() => {
    if (isLoginRoute) return

    const handleActivity = () => {
      if (!enforceTimeout()) return

      const now = Date.now()
      if (now - lastActivityWriteRef.current < activityWriteThrottleMs) return

      lastActivityWriteRef.current = now
      markAuthActivity(now)
      void touchServerSession()
    }

    const handleVisibility = () => {
      if (!document.hidden) handleActivity()
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === AUTH_TOKEN_STORAGE_KEY && !event.newValue) redirectToLogin('logout')
    }

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, handleActivity, { passive: true })
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleActivity)
    window.addEventListener('storage', handleStorage)

    const intervalId = window.setInterval(enforceTimeout, timeoutCheckIntervalMs)

    return () => {
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, handleActivity)
      }
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleActivity)
      window.removeEventListener('storage', handleStorage)
      window.clearInterval(intervalId)
    }
  }, [enforceTimeout, isLoginRoute, redirectToLogin, touchServerSession])

  return null
}
