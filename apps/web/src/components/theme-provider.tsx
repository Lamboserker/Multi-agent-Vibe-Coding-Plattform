'use client'

import { useEffect } from 'react'

const storageKey = 'multi-ai-coder-theme'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey)
    const systemTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    document.documentElement.dataset.theme = stored === 'light' || stored === 'dark' ? stored : systemTheme
  }, [])

  return children
}

export { storageKey as themeStorageKey }
