// AK-58 sub-task 3 — per-tab session metadata for the caregiver dashboard.
//
// We do NOT store the customToken returned by acceptCaregiverGrant. It is
// exchanged for a Firebase ID token via signInWithCustomToken() immediately
// on accept; Firebase Auth then manages the session in its own session-
// persistence-backed sessionStorage. This record carries only the metadata
// the dashboard needs to render and to enforce the 7-day conceptual expiry
// without re-deriving it from the ID token claims on every read.

const STORAGE_KEY = 'medicab.caregiverSession'

export interface CaregiverSession {
  hId: string
  grantId: string
  visibleMemberId: string
  expiresAt: number // epoch ms
}

export function storeCaregiverSession(session: CaregiverSession): void {
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function getCaregiverSession(): CaregiverSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CaregiverSession>
    if (
      typeof parsed.hId !== 'string' ||
      typeof parsed.grantId !== 'string' ||
      typeof parsed.visibleMemberId !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }
    return parsed as CaregiverSession
  } catch {
    return null
  }
}

export function isSessionExpired(session: CaregiverSession): boolean {
  return session.expiresAt < Date.now()
}

export function clearCaregiverSession(): void {
  window.sessionStorage.removeItem(STORAGE_KEY)
}
