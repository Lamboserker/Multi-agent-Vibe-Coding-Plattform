/**
 * Local dev servers (http://localhost:5173, http://127.0.0.1:3000 …) are shown inside the app in a
 * preview tab instead of the external browser. Shared by the main process (CSP, navigation guard)
 * and the renderer (where a link opens).
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/** The URL to show in the preview tab, or undefined when it is not a local http(s) address. */
export function localPreviewUrl(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password) return undefined
  const host = url.hostname.toLowerCase()
  if (!LOCAL_HOSTS.has(host) && !host.endsWith('.localhost')) return undefined
  // 0.0.0.0 is what servers print when they listen on all interfaces; it is reached as localhost
  if (host === '0.0.0.0') url.hostname = 'localhost'
  return url.toString()
}

export const isLocalPreviewUrl = (input: string) => localPreviewUrl(input) !== undefined
