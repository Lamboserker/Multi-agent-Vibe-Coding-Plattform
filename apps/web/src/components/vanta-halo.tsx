"use client"

import { useEffect, useRef } from 'react'

export default function VantaHalo() {
  const ref = useRef<HTMLDivElement | null>(null)
  const vantaRef = useRef<any>(null)

  useEffect(() => {
    let mounted = true

    const loadScript = (src: string) =>
      new Promise<void>((resolve, reject) => {
        if (document.querySelector(`script[src=\"${src}\"]`)) return resolve()
        const script = document.createElement('script')
        script.src = src
        script.async = true
        script.onload = () => resolve()
        script.onerror = () => reject(new Error(`Failed to load ${src}`))
        document.head.appendChild(script)
      })

    ;(async () => {
      try {
        // Load Three and Vanta from CDNs. These scripts set window.THREE and window.VANTA
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js')
        await loadScript('https://cdn.jsdelivr.net/npm/vanta@0.5.21/dist/vanta.halo.min.js')

        if (!mounted) return
        const anyWindow = window as any
        if (anyWindow.VANTA && anyWindow.VANTA.HALO && ref.current) {
          vantaRef.current = anyWindow.VANTA.HALO({
            el: ref.current,
            mouseControls: true,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.0,
            minWidth: 200.0,
          })
        }
      } catch (err) {
        // silent fail — background shouldn't break the dashboard
        // eslint-disable-next-line no-console
        console.warn('Vanta failed to load', err)
      }
    })()

    return () => {
      mounted = false
      if (vantaRef.current && typeof vantaRef.current.destroy === 'function') vantaRef.current.destroy()
    }
  }, [])

  return <div ref={ref} className="vanta-bg" aria-hidden />
}
