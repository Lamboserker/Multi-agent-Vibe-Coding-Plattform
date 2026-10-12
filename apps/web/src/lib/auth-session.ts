import { API_BASE_URL } from './api'
import { clearAuthSession, readAuthToken } from './auth-storage'

export async function revokeCurrentSession() {
  const token = readAuthToken()

  if (token) {
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
    } catch {
      // Local logout still has to complete if the backend is not reachable.
    }
  }

  clearAuthSession()
}
