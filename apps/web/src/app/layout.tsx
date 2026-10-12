import type { Metadata } from 'next'
import { JetBrains_Mono, Rajdhani } from 'next/font/google'
import { AuthSessionManager } from '@/components/auth-session-manager'
import { ThemeProvider } from '@/components/theme-provider'
import './globals.css'

const rajdhani = Rajdhani({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

const jetBrainsMono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})

export const metadata: Metadata = {
  title: 'Multi-AI Coder',
  description: 'Cost-aware multi-model coding orchestrator MVP',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${rajdhani.variable} ${jetBrainsMono.variable}`}>
      <body>
        <ThemeProvider>
          <AuthSessionManager />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
