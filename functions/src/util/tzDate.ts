// AK-171 — Timezone-aware date helpers, generalising the earlier istDate
// module. The dose-reminder cron and missed-dose sweep both compute "is it
// time to send this slot?" against an IANA timezone (e.g. 'Asia/Kolkata',
// 'America/Los_Angeles') that's denormalised onto each regimen at creation
// time. IST-only callers (currently todaySummary doc-id sharding) use the
// backward-compat aliases at the bottom of this file.
//
// Implementation note for slotInstant: the algorithm round-trips through
// Intl.DateTimeFormat with a fixed locale and explicit components, rather
// than relying on locale-dependent Date string parsing — that path is
// implementation-defined in ECMA-262 and has bitten projects when a
// runtime upgrade tightened its parser.

// Returns "YYYY-MM-DD" for the given instant in the given IANA timezone.
// Uses sv-SE locale to force ISO-like ordering regardless of container locale.
export function dateInTz(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

// Given "YYYY-MM-DD" + "HH:MM" wall-clock in the given IANA timezone,
// returns the equivalent absolute UTC Date.
//
// Correctly handles fixed-offset zones (e.g. 'Asia/Kolkata' = +05:30 with
// no DST) AND zones with DST (e.g. 'America/Los_Angeles'). For wall-clocks
// that fall in a spring-forward gap (don't exist) or fall-back overlap
// (exist twice), the returned instant is the one Intl would produce for
// a UTC source — pragmatic and stable across re-runs.
export function slotInstant(dateStr: string, hhmm: string, tz: string): Date {
  const [yyyy, mm, dd] = dateStr.split('-').map(Number)
  const [HH, MM] = hhmm.split(':').map(Number)

  // First treat the wall-clock as if it were UTC. We'll learn the zone's
  // offset for that instant below and shift accordingly.
  const asUTC = Date.UTC(yyyy, mm - 1, dd, HH, MM, 0)

  // Format that UTC instant in the target zone with a parser-friendly layout.
  // sv-SE gives us "YYYY-MM-DD HH:MM:SS" with zero-padding.
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(asUTC))

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find(p => p.type === type)
    return part ? Number(part.value) : 0
  }

  // "What UTC components would this instant have if you read it in tz?"
  const tzAsUTC = Date.UTC(get('year'), get('month') - 1, get('day'),
                           get('hour'), get('minute'), get('second'))

  // Difference = the zone's offset at that instant (positive east of UTC).
  const offsetMs = tzAsUTC - asUTC

  // The true UTC instant for the requested wall-clock is asUTC minus offset.
  return new Date(asUTC - offsetMs)
}

// Day of week (0 = Sun … 6 = Sat) for an absolute instant viewed in `tz`.
export function dayOfWeekInTz(now: Date, tz: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short',
  }).format(now)
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(weekday)
}

// Day of week for a "YYYY-MM-DD" calendar date in `tz`. Anchored at noon so
// the answer is invariant under DST shifts that span the same calendar day.
export function dayOfWeekForDateInTz(dateStr: string, tz: string): number {
  return dayOfWeekInTz(slotInstant(dateStr, '12:00', tz), tz)
}

// Returns the "YYYY-MM-DD" calendar date one day before `dateStr` in `tz`.
// Anchors at noon and steps back 24h to dodge DST edge cases at midnight.
export function previousDateInTz(dateStr: string, tz: string): string {
  const noon = slotInstant(dateStr, '12:00', tz)
  noon.setUTCDate(noon.getUTCDate() - 1)
  return dateInTz(noon, tz)
}

// ─── Backward-compat IST aliases ──────────────────────────────────────────
// Kept so callers that legitimately need IST (notably the todaySummary doc-id
// path — Phase 2 will shard per-patient-tz) don't need to spell out
// 'Asia/Kolkata' every time. These also let the file rename land without
// breaking imports outside the dose-reminder cron.
export const todayISTDateString = (now: Date): string => dateInTz(now, 'Asia/Kolkata')
export const istSlotInstant = (dateStr: string, hhmm: string): Date =>
  slotInstant(dateStr, hhmm, 'Asia/Kolkata')
export const dayOfWeekForISTDate = (dateStr: string): number =>
  dayOfWeekForDateInTz(dateStr, 'Asia/Kolkata')
export const previousISTDateString = (dateStr: string): string =>
  previousDateInTz(dateStr, 'Asia/Kolkata')
