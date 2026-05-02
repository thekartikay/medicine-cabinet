import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore'
import type { User as FirebaseUser } from 'firebase/auth'
import { db } from '../lib/firebase'
import { userPath, householdPath, memberPath } from '../lib/paths'
import type { AppUser } from '../types'

export async function createUserIfNew(user: FirebaseUser): Promise<void> {
  const ref = doc(db, userPath(user.uid))
  const snap = await getDoc(ref)
  if (snap.exists()) return

  await setDoc(ref, {
    uid: user.uid,
    displayName: user.displayName,
    email: user.email ?? null,
    phoneNumber: user.phoneNumber ?? null,
    photoURL: user.photoURL ?? null,
    createdAt: serverTimestamp(),
  })
}

export async function getUserDoc(uid: string): Promise<AppUser | null> {
  const snap = await getDoc(doc(db, userPath(uid)))
  if (!snap.exists()) return null
  return snap.data() as AppUser
}

export async function createHousehold(
  user: FirebaseUser,
  name: string,
): Promise<{ hId: string; name: string }> {
  const hId = crypto.randomUUID()
  const batch = writeBatch(db)

  batch.set(doc(db, householdPath(hId)), {
    hId,
    name,
    primaryAdminId: user.uid,
    adminIds: [user.uid],
    memberUids: [user.uid],
    createdAt: serverTimestamp(),
    lastAuditAt: null,
  })

  batch.set(doc(db, memberPath(hId, user.uid)), {
    uid: user.uid,
    hId,
    role: 'admin',
    displayName: user.displayName,
    joinedAt: serverTimestamp(),
  })

  // merge:true guards against the race where createUserIfNew failed silently
  batch.set(doc(db, userPath(user.uid)), { householdId: hId }, { merge: true })

  await batch.commit()
  return { hId, name }
}

export async function getHousehold(
  hId: string,
): Promise<{ hId: string; name: string } | null> {
  const snap = await getDoc(doc(db, householdPath(hId)))
  if (!snap.exists()) return null
  const data = snap.data()
  return { hId: data['hId'] as string, name: data['name'] as string }
}
