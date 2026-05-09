// Detects the runtime platform without depending on @capacitor/core, which is
// not yet installed in this project. Capacitor exposes itself on
// window.Capacitor when the native shell wraps the WebView; outside that we
// fall back to UA sniffing and finally to 'web'. Returns 'web' | 'ios' | 'android'.
export function detectPlatform(): 'web' | 'ios' | 'android' {
  if (typeof window === 'undefined') return 'web'
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  const fromCap = cap?.getPlatform?.()
  if (fromCap === 'ios' || fromCap === 'android' || fromCap === 'web') return fromCap
  const ua = (navigator?.userAgent ?? '').toLowerCase()
  if (/iphone|ipad|ipod/.test(ua)) return 'ios'
  if (/android/.test(ua)) return 'android'
  return 'web'
}
