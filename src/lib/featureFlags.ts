// Build-time feature flags read from Vite env vars. Each flag is opt-in
// via a literal "true" string so production builds default to safe-off
// unless the env explicitly turns the feature on.

// MC-004 — gates the Cabinet Query FAB (built in the next ticket). The
// proxy itself enforces auth, App Check, and rate limits, so flipping
// this on is purely a UI affordance, not a security boundary.
export const CABINET_QUERY_ENABLED =
  import.meta.env.VITE_ENABLE_CABINET_QUERY === 'true'
