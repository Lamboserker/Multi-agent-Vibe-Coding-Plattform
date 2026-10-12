'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { themeStorageKey } from './theme-provider'

type Theme = 'dark' | 'light'

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    setTheme(current)
  }, [])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    window.localStorage.setItem(themeStorageKey, next)
    setTheme(next)
  }

  return (
    <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
      {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
      Theme: {theme === 'dark' ? 'Dark' : 'Light'}
    </button>
  )
}
