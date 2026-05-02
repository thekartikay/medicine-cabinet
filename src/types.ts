import type { Timestamp } from 'firebase/firestore'

export interface AppUser {
  uid: string
  displayName: string | null
  email: string | null
  phoneNumber: string | null
  photoURL: string | null
  createdAt: Timestamp
  householdId?: string
}

export interface Household {
  hId: string
  name: string
  primaryAdminId: string
  adminIds: string[]
  memberUids: string[]
  createdAt: Timestamp
  lastAuditAt: Timestamp | null
}

export interface HouseholdMember {
  uid: string
  hId: string
  role: 'admin' | 'member' | 'caregiver'
  displayName: string | null
  joinedAt: Timestamp
}
