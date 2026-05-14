// Build-time feature flags read from Vite env vars. Each flag is opt-in
// via a literal "true" string so production builds default to safe-off
// unless the env explicitly turns the feature on.

// MC-004 — gates the Cabinet Query FAB. The proxy itself enforces auth,
// App Check, and rate limits, so flipping this on is purely a UI
// affordance, not a security boundary.
//
// Hardcoded `true` for closed beta (the previous env-var check meant the
// flag only flipped on when VITE_ENABLE_CABINET_QUERY=true was set at
// build time). Kept as a named constant so the gate stays explicit and
// greppable rather than disappearing into an inline `true`.
export const CABINET_QUERY_ENABLED = true
