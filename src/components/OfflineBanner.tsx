import { useEffect, useState } from 'react'

// Fixed-top banner that surfaces only when the browser reports the device is
// offline. Listens to window 'online' / 'offline' events; renders nothing
// while online. No dismiss button — the banner auto-hides as soon as
// connectivity returns.
export function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  useEffect(() => {
    const on = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  if (isOnline) return null

  return (
    <div className="ob-banner" role="status" aria-live="polite">
      <span className="ob-icon">⚠</span>
      <span className="ob-text">No internet connection</span>
    </div>
  )
}
