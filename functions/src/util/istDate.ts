// Shared IST helpers. Extracted from functions/src/index.ts so the dose
// reminder cron, the maintainTodaySummary triggers, and the geminiProxy
// rate limiter all read from one source of truth and cannot drift apart.
//
// Asia/Kolkata is fixed at +05:30 with no DST, so a single formatter is
// safe across the whole day and does not need to be re-instantiated.

// Returns IST date for the given instant as YYYY-MM-DD. Uses the Swedish
// (sv-SE) locale because it formats dates in ISO order; pinning the locale
// keeps output stable across runtime versions and container locales.
export function todayISTDateString(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}
