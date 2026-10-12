export interface BadgeProps {
  label: string
}

/** Small label used across the app. */
export function Badge({ label }: BadgeProps) {
  return <span className="badge">{label}</span>
}
