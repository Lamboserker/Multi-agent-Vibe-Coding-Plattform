import type { CSSProperties, ReactNode } from 'react'
import { Ban, Cpu, Sparkles, Wrench, type LucideIcon } from 'lucide-react'
import { TONE, type Tone } from '../lib/leitstand'

/* Small building blocks of the design: segmented controls, chips, bars, tone dots, eyebrows. */

export function Seg<T extends string>({ value, options, onChange, size = 'md', label }: { value: T; options: Array<{ id: T; label: ReactNode; icon?: LucideIcon; title?: string; disabled?: boolean }>; onChange: (value: T) => void; size?: 'sm' | 'md'; label?: string }) {
  return (
    <div className={`seg ${size}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} role="radio" aria-checked={value === option.id} className={value === option.id ? 'on' : ''} title={option.title} disabled={option.disabled} onClick={() => onChange(option.id)}>
          {option.icon ? <option.icon size={12} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Dot({ tone, pulse, size = 7 }: { tone: Tone | string; pulse?: boolean; size?: number }) {
  const color = tone in TONE ? TONE[tone as Tone].color : tone
  return <span className={`tone-dot ${pulse ? 'pulse' : ''}`} style={{ width: size, height: size, background: color }} />
}

export function Chip({ tone = 'faint', children, title, mono = true }: { tone?: Tone; children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <span className={`chip ${mono ? 'mono' : ''}`} title={title} style={{ background: TONE[tone].soft, color: TONE[tone].color }}>
      {children}
    </span>
  )
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="status-pill" style={{ color: TONE[tone].color, background: TONE[tone].soft }}>
      <Dot tone={tone} size={6} />
      {children}
    </span>
  )
}

export function Bar({ value, tone = 'accent', height = 4, title }: { value: number | undefined; tone?: Tone | string; height?: number; title?: string }) {
  const color = tone in TONE ? TONE[tone as Tone].color : tone
  return (
    <div className="bar" style={{ height }} title={title}>
      <div style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%`, background: color }} />
    </div>
  )
}

export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="eyebrow" style={style}>{children}</div>
}

const KIND_ICON = { cpu: Cpu, sparkles: Sparkles, wrench: Wrench, ban: Ban }

export function KindIcon({ icon, tone, size = 22 }: { icon: keyof typeof KIND_ICON; tone: Tone; size?: number }) {
  const Icon = KIND_ICON[icon]
  return (
    <span className="kind-icon" style={{ width: size, height: size, background: TONE[tone].soft, color: TONE[tone].color }}>
      <Icon size={Math.round(size * 0.6)} />
    </span>
  )
}

/** Tile with a small label, a value and an optional detail (models, usage, sessions). */
export function StatTile({ label, value, detail, mono, icon: Icon, children }: { label: ReactNode; value: ReactNode; detail?: ReactNode; mono?: boolean; icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{Icon ? <Icon size={13} /> : null}{label}</div>
      <div className={`stat-value ${mono ? 'mono' : ''}`}>{value}</div>
      {children}
      {detail !== undefined ? <div className="stat-detail">{detail}</div> : null}
    </div>
  )
}

export function ScreenHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="screen-header">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="screen-title">{title}</div>
        {subtitle ? <div className="screen-subtitle">{subtitle}</div> : null}
      </div>
      {children}
    </div>
  )
}

/** Bar sparkline; a null value is a point without measurement and stays an empty gap. */
export function Spark({ values, tone, max = 100 }: { values: Array<number | null>; tone: string; max?: number }) {
  const bars = values.length ? values : [0]
  return (
    <div className="spark" aria-hidden>
      {bars.map((value, index) => (
        <div key={index} style={value === null ? { height: 0, background: 'transparent' } : { height: `${Math.max(4, Math.round((value / max) * 100))}%`, background: tone, opacity: 0.35 + 0.65 * (index / Math.max(1, bars.length - 1)) }} />
      ))}
    </div>
  )
}
