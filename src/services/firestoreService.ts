import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  runTransaction,
  setDoc,
  updateDoc,
  serverTimestamp,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  arrayUnion,
  Timestamp,
} from 'firebase/firestore'
import type { User as FirebaseUser } from 'firebase/auth'
import { db } from '../lib/firebase'
import {
  userPath,
  householdPath,
  memberPath,
  cabinetPath,
  itemPath,
  itemsCollectionPath,
  treatmentPath,
  regimenPath,
  treatmentsCollectionPath,
  regimensCollectionPath,
  membersCollectionPath,
  dosePath,
  dosesCollectionPath,
  notificationPath,
  notificationsCollectionPath,
  restockRequestsCollectionPath,
  restockRequestPath,
  todaySummaryPath,
  consentLogPath,
  CURRENT_POLICY_VERSION,
  buildSlotId,
  todayISTString,
} from '../lib/paths'
import type {
  AppUser,
  CabinetItem,
  CabinetItemUnit,
  ConsentRecord,
  DoseLog,
  DoseSlotDisplay,
  DoseStatus,
  Household,
  HouseholdMember,
  MasterMedicine,
  Notification,
  PauseEntry,
  Regimen,
  RestockRequest,
  ScheduleType,
  TimeSlot,
  TodaySummary,
  Treatment,
  TreatmentCategory,
} from '../types'

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

// Note: household creation now lives in the createHousehold Cloud Function
// (functions/src/index.ts). The client must call that function rather than
// writing /households/* directly because Firestore Security Rules deny:
//   - members[*] writes by anyone other than an admin of the household
//   - users[uid].householdId being set to anything by the user themselves
//   - and only Cloud Functions can issue the 'admin' custom claim.

export async function getHousehold(
  hId: string,
): Promise<{ hId: string; name: string } | null> {
  const snap = await getDoc(doc(db, householdPath(hId)))
  if (!snap.exists()) return null
  const data = snap.data()
  return { hId: data['hId'] as string, name: data['name'] as string }
}

// Returns the cId of the household's default cabinet, creating it if it doesn't exist.
// Uses a deterministic cId (`${hId}-default`) so concurrent calls are idempotent.
export async function getOrCreateDefaultCabinet(hId: string): Promise<string> {
  const cId = `${hId}-default`
  const ref = doc(db, cabinetPath(hId, cId))
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    await setDoc(ref, { cId, hId, name: 'Main Cabinet', createdAt: serverTimestamp() })
  }
  return cId
}

export async function getCabinetItems(hId: string, cId: string): Promise<CabinetItem[]> {
  const snap = await getDocs(collection(db, itemsCollectionPath(hId, cId)))
  return snap.docs.map(d => d.data() as CabinetItem)
}

export async function addCabinetItem(
  hId: string,
  cId: string,
  data: {
    medicineId: string
    displayNameOverride: string | null
    quantityOnHand: number
    unit: CabinetItemUnit
    expiryDate: string | null
    prescribed: boolean
    // Optional enrichment fields surfaced in the new add-medicine flow.
    brandName?: string | null
    dosageForm?: string | null
    strength?: string | null
    activeIngredients?: string | null
    marketer?: string | null
    storageInstructions?: string | null
  },
): Promise<string> {
  const iId = crypto.randomUUID()
  await setDoc(doc(db, itemPath(hId, cId, iId)), {
    ...data,
    iId,
    cId,
    hId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return iId
}

export function subscribeCabinetItems(
  hId: string,
  cId: string,
  onData: (items: CabinetItem[]) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, itemsCollectionPath(hId, cId)),
    snap => onData(snap.docs.map(d => d.data() as CabinetItem)),
    err => onError?.(err),
  )
}

export async function searchMasterDb(queryStr: string): Promise<MasterMedicine[]> {
  if (!queryStr.trim()) return []
  const q = query(
    collection(db, 'masterDb'),
    where('name', '>=', queryStr),
    where('name', '<', queryStr + '\uf8ff'),
    limit(10),
  )
  const snap = await getDocs(q)
  return snap.docs.map(d => d.data() as MasterMedicine)
}

// ── Treatments ───────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function computeScheduleSummary(
  scheduleType: ScheduleType,
  scheduleDays: number[] | null,
  slots: TimeSlot[],
): string {
  if (scheduleType === "as-needed") return "As needed"
  const times = slots.map(s => s.time).join(", ")
  if (scheduleType === "daily") return `Daily at ${times}`
  const days = (scheduleDays ?? []).slice().sort((a, b) => a - b).map(d => DAY_NAMES[d]).join(", ")
  return `${days} at ${times}`
}

export async function createTreatment(
  hId: string,
  data: {
    name: string
    memberId: string
    memberName: string | null
    category: TreatmentCategory
  },
): Promise<string> {
  const tId = crypto.randomUUID()
  await setDoc(doc(db, treatmentPath(hId, tId)), {
    tId,
    hId,
    name: data.name,
    memberId: data.memberId,
    memberName: data.memberName,
    category: data.category,
    status: "active",
    scheduleSummary: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return tId
}

export async function addRegimen(
  hId: string,
  tId: string,
  data: {
    cabinetItemId: string
    medicineId: string
    displayName: string
    doseAmount: number
    doseUnit: string
    scheduleType: ScheduleType
    scheduleDays: number[] | null
    slots: TimeSlot[]
    startDate: string
    endDate: string | null
    ongoing: boolean
  },
): Promise<string> {
  const rId = crypto.randomUUID()
  const summary = computeScheduleSummary(data.scheduleType, data.scheduleDays, data.slots)
  const batch = writeBatch(db)

  batch.set(doc(db, regimenPath(hId, tId, rId)), {
    ...data,
    rId,
    tId,
    hId,
    createdAt: serverTimestamp(),
  })

  // merge:true keeps the rest of the treatment doc intact and is safe even
  // in the unlikely race where the treatment doc is not yet visible to this batch.
  batch.set(
    doc(db, treatmentPath(hId, tId)),
    { scheduleSummary: summary, updatedAt: serverTimestamp() },
    { merge: true },
  )

  await batch.commit()
  return rId
}

export function subscribeTreatments(
  hId: string,
  onData: (treatments: Treatment[]) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    collection(db, treatmentsCollectionPath(hId)),
    snap => onData(snap.docs.map(d => d.data() as Treatment)),
    err => onError?.(err),
  )
}

export async function getHouseholdMembers(hId: string): Promise<HouseholdMember[]> {
  const snap = await getDocs(collection(db, membersCollectionPath(hId)))
  return snap.docs.map(d => d.data() as HouseholdMember)
}

// Convenience: resolves the household default cabinet and returns its items.
export async function getDefaultCabinetItems(hId: string): Promise<CabinetItem[]> {
  const cId = await getOrCreateDefaultCabinet(hId)
  return getCabinetItems(hId, cId)
}

// Computes today applicable dose slots from active treatments and their regimens.
// Client-side fallback — the canonical source is todaySummary/{date} written by Cloud Functions.
export async function loadTodaysDoses(hId: string): Promise<DoseSlotDisplay[]> {
  const today = todayISTString()
  const todayDow = new Date(today + "T00:00:00").getDay()

  const treatsSnap = await getDocs(
    query(collection(db, treatmentsCollectionPath(hId)), where("status", "==", "active")),
  )

  const all: DoseSlotDisplay[] = []

  await Promise.all(treatsSnap.docs.map(async tDoc => {
    const treat = tDoc.data() as Treatment
    const regSnap = await getDocs(collection(db, regimensCollectionPath(hId, treat.tId)))

    for (const rDoc of regSnap.docs) {
      const reg = rDoc.data() as Regimen
      if (reg.startDate > today) continue
      if (reg.endDate && reg.endDate < today) continue
      if (reg.scheduleType === "as-needed") continue
      if (reg.scheduleType === "specific-days" && !reg.scheduleDays?.includes(todayDow)) continue

      for (const slot of reg.slots) {
        const hhmm = slot.time.replace(':', '')
        const slotId = buildSlotId(treat.tId, reg.rId, treat.memberId, today, hhmm)
        all.push({
          treatmentId: treat.tId,
          treatmentName: treat.name,
          memberName: treat.memberName,
          medicineName: reg.displayName,
          doseAmount: reg.doseAmount,
          doseUnit: reg.doseUnit,
          time: slot.time,
          foodTiming: slot.foodTiming,
          regimenId: reg.rId,
          slotId,
          patientId: treat.memberId,
          cabinetItemId: reg.cabinetItemId,
        })
      }
    }
  }))

  return all.sort((a, b) => a.time.localeCompare(b.time))
}


// ── Dose logging ─────────────────────────────────────────────

// Loads all dose logs scheduled for today across active treatments.
export async function loadTodaysLogs(hId: string): Promise<DoseLog[]> {
  const today = todayISTString()
  const treatsSnap = await getDocs(
    query(collection(db, treatmentsCollectionPath(hId)), where("status", "==", "active")),
  )

  const all: DoseLog[] = []

  await Promise.all(treatsSnap.docs.map(async tDoc => {
    const treat = tDoc.data() as Treatment
    const logsSnap = await getDocs(
      query(
        collection(db, dosesCollectionPath(hId, treat.tId)),
        where("scheduledDate", "==", today),
      ),
    )
    for (const logDoc of logsSnap.docs) {
      all.push(logDoc.data() as DoseLog)
    }
  }))

  return all
}

// Logs a dose. Per CLAUDE.md rules:
//  - rule 3: deterministic slot id via buildSlotId(); never addDoc()
//  - rule 4: log + inventory debit happen in a single runTransaction()
//  - rule 5: audit fence — write the log but skip the debit if scheduledAt < household.lastAuditAt
// Idempotent: if the slot is already logged, returns the existing state without re-debiting.
export async function logDose(
  hId: string,
  args: {
    tId: string
    rId: string
    patientId: string
    cabinetItemId: string
    scheduledDate: string    // YYYY-MM-DD
    scheduledTime: string    // HH:MM
    doseAmount: number
    doseUnit: string
    status: DoseStatus
    skipReason?: string | null
    lateNote?: string | null
    createdBy: string
  },
): Promise<{ slotId: string; inventoryDebited: boolean; alreadyLogged: boolean }> {
  const cId = await getOrCreateDefaultCabinet(hId)
  const hhmm = args.scheduledTime.replace(":", "")
  const slotId = buildSlotId(args.tId, args.rId, args.patientId, args.scheduledDate, hhmm)
  const scheduledAt = new Date(`${args.scheduledDate}T${args.scheduledTime}:00+05:30`)

  return runTransaction(db, async tx => {
    // ── ALL READS FIRST (Firestore transaction requirement) ──
    const householdRef = doc(db, householdPath(hId))
    const householdSnap = await tx.get(householdRef)
    if (!householdSnap.exists()) throw new Error("Household not found")

    const logRef = doc(db, dosePath(hId, args.tId, slotId))
    const existingLog = await tx.get(logRef)

    const itemRef = doc(db, itemPath(hId, cId, args.cabinetItemId))
    const itemSnap = await tx.get(itemRef)

    // ── Idempotency ──
    // 'missed' is special: written by the markMissedDoses cron (MC-007) and
    // meant to be overwritten when the user actually marks the dose later.
    // Any other status is terminal — returning early avoids clobbering a
    // taken/late log and (critically) re-debiting inventory.
    const existing = existingLog.exists() ? (existingLog.data() as DoseLog) : null
    if (existing && existing.status !== "missed") {
      return { slotId, inventoryDebited: existing.inventoryDebited, alreadyLogged: true }
    }
    const previouslyDebited = existing?.inventoryDebited ?? false

    // ── Audit fence ──
    const household = householdSnap.data() as Household
    const lastAuditAt = household.lastAuditAt
    const auditFenced = lastAuditAt != null && scheduledAt.getTime() < lastAuditAt.toMillis()

    // Debit only when transitioning to taken/late, the audit fence allows it,
    // the cabinet item still exists, AND the prior log (if any) didn't
    // already debit. Last guard prevents double-debit on overwrite.
    const debitsInventory =
      (args.status === "taken" || args.status === "late")
      && !auditFenced
      && itemSnap.exists()
      && !previouslyDebited

    let newQty = 0
    if (debitsInventory) {
      const item = itemSnap.data() as CabinetItem
      newQty = Math.max(0, item.quantityOnHand - args.doseAmount)
    }

    // ── ALL WRITES (atomic with the reads above) ──
    tx.set(logRef, {
      slotId,
      tId: args.tId,
      rId: args.rId,
      hId,
      patientId: args.patientId,
      scheduledAt: Timestamp.fromDate(scheduledAt),
      scheduledDate: args.scheduledDate,
      scheduledTime: args.scheduledTime,
      status: args.status,
      takenAt: serverTimestamp(),
      skipReason: args.skipReason ?? null,
      lateNote: args.lateNote ?? null,
      doseAmount: args.doseAmount,
      doseUnit: args.doseUnit,
      cabinetItemId: args.cabinetItemId,
      inventoryDebited: debitsInventory,
      createdBy: args.createdBy,
      createdAt: serverTimestamp(),
    })

    if (debitsInventory) {
      tx.update(itemRef, {
        quantityOnHand: newQty,
        updatedAt: serverTimestamp(),
      })
    }

    return { slotId, inventoryDebited: debitsInventory, alreadyLogged: false }
  })
}

// Admin override: mark a missed dose as taken on behalf of a member. Mirrors
// logDose's transactional shape — single runTransaction for the log + debit
// (CLAUDE.md rule 4) and respects the audit fence (rule 5). Idempotent: if
// the log already records a non-missed status (e.g., the member just marked
// it taken in parallel), returns the existing state without re-debiting.
//
// Stamps `adminOverride: true` and `createdBy: adminUid` on the new log so
// the dose card can render "Updated by admin".
export async function adminMarkAsTaken(
  hId: string,
  args: {
    tId: string
    rId: string
    patientId: string
    cabinetItemId: string
    scheduledDate: string    // YYYY-MM-DD
    scheduledTime: string    // HH:MM
    doseAmount: number
    doseUnit: string
    adminUid: string
    // For the admin_override notification message. Caller knows these from
    // DoseSlotDisplay; pulling them in avoids a server-side member lookup.
    medicineName: string
    memberName: string | null
    adminName: string | null
  },
): Promise<{ slotId: string; inventoryDebited: boolean; alreadyLogged: boolean }> {
  const cId = await getOrCreateDefaultCabinet(hId)
  const hhmm = args.scheduledTime.replace(":", "")
  const slotId = buildSlotId(args.tId, args.rId, args.patientId, args.scheduledDate, hhmm)
  const scheduledAt = new Date(`${args.scheduledDate}T${args.scheduledTime}:00+05:30`)

  return runTransaction(db, async tx => {
    const householdRef = doc(db, householdPath(hId))
    const householdSnap = await tx.get(householdRef)
    if (!householdSnap.exists()) throw new Error("Household not found")

    const logRef = doc(db, dosePath(hId, args.tId, slotId))
    const existingLog = await tx.get(logRef)

    const itemRef = doc(db, itemPath(hId, cId, args.cabinetItemId))
    const itemSnap = await tx.get(itemRef)

    const existing = existingLog.exists() ? (existingLog.data() as DoseLog) : null
    if (existing && existing.status !== "missed") {
      return { slotId, inventoryDebited: existing.inventoryDebited, alreadyLogged: true }
    }
    const previouslyDebited = existing?.inventoryDebited ?? false

    const household = householdSnap.data() as Household
    const lastAuditAt = household.lastAuditAt
    const auditFenced = lastAuditAt != null && scheduledAt.getTime() < lastAuditAt.toMillis()

    const debitsInventory = !auditFenced && itemSnap.exists() && !previouslyDebited

    let newQty = 0
    if (debitsInventory) {
      const item = itemSnap.data() as CabinetItem
      newQty = Math.max(0, item.quantityOnHand - args.doseAmount)
    }

    tx.set(logRef, {
      slotId,
      tId: args.tId,
      rId: args.rId,
      hId,
      patientId: args.patientId,
      scheduledAt: Timestamp.fromDate(scheduledAt),
      scheduledDate: args.scheduledDate,
      scheduledTime: args.scheduledTime,
      status: "taken" as DoseStatus,
      takenAt: serverTimestamp(),
      skipReason: null,
      lateNote: null,
      doseAmount: args.doseAmount,
      doseUnit: args.doseUnit,
      cabinetItemId: args.cabinetItemId,
      inventoryDebited: debitsInventory,
      createdBy: args.adminUid,
      createdAt: serverTimestamp(),
      adminOverride: true,
    })

    if (debitsInventory) {
      tx.update(itemRef, {
        quantityOnHand: newQty,
        updatedAt: serverTimestamp(),
      })
    }

    return { slotId, inventoryDebited: debitsInventory, alreadyLogged: false }
  }).then(async (result) => {
    // Notification write is non-transactional and best-effort: a failed
    // notification must NOT roll back the override. Skip the write entirely
    // when alreadyLogged=true (no state change worth notifying about).
    if (!result.alreadyLogged) {
      const notifId = `override_${result.slotId}`
      const adminLabel = args.adminName?.trim() || 'An admin'
      const memberLabel = args.memberName?.trim() || 'a member'
      try {
        await setDoc(doc(db, notificationPath(hId, notifId)), {
          notifId,
          type: 'admin_override',
          message: `${adminLabel} marked ${args.medicineName} as taken for ${memberLabel}`,
          createdAt: serverTimestamp(),
          readBy: [args.adminUid],
          relatedMemberId: args.patientId,
          relatedMedicineId: args.cabinetItemId,
        })
      } catch {
        // Don't fail the override if the notification write fails.
      }
    }
    return result
  })
}

// ── Notifications ───────────────────────────────────────────

export function subscribeNotifications(
  hId: string,
  onData: (notifs: Notification[]) => void,
  onError?: (error: Error) => void,
): () => void {
  // 30-day window keeps the panel feed bounded. Single-field where + orderBy
  // on createdAt is auto-indexed; no firestore.indexes.json change needed.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const q = query(
    collection(db, notificationsCollectionPath(hId)),
    where('createdAt', '>=', Timestamp.fromDate(cutoff)),
    orderBy('createdAt', 'desc'),
    limit(50),
  )
  return onSnapshot(
    q,
    snap => onData(snap.docs.map(d => d.data() as Notification)),
    err => onError?.(err),
  )
}

export async function markNotificationRead(
  hId: string,
  notifId: string,
  uid: string,
): Promise<void> {
  await updateDoc(doc(db, notificationPath(hId, notifId)), {
    readBy: arrayUnion(uid),
  })
}

// Batch-update only the genuinely-unread notifs so we don't churn no-op writes.
export async function markAllNotificationsRead(
  hId: string,
  notifs: Notification[],
  uid: string,
): Promise<void> {
  const unread = notifs.filter(n => !n.readBy.includes(uid))
  if (unread.length === 0) return
  const batch = writeBatch(db)
  for (const n of unread) {
    batch.update(doc(db, notificationPath(hId, n.notifId)), {
      readBy: arrayUnion(uid),
    })
  }
  await batch.commit()
}

// Look up a household member's displayName. Used by Dashboard's "Updated by
// [name]" lookup — the users/{uid} collection's read rule is self-only, so
// we read from the household's members subcollection (read: isParticipant).
export async function getMemberDisplayName(
  hId: string,
  uid: string,
): Promise<string | null> {
  const snap = await getDoc(doc(db, memberPath(hId, uid)))
  if (!snap.exists()) return null
  const data = snap.data() as { displayName?: string | null }
  return data.displayName ?? null
}

// ── Today summary (Cloud-Function-maintained dashboard cache) ─

// Live read of the single per-household-per-day summary doc that
// maintainTodaySummary keeps in sync. Returns null if the doc doesn't exist
// yet (e.g., a brand-new household before the midnight cron has run).
// Dashboard.tsx falls back to the direct-query path when null is observed.
export function subscribeTodaySummary(
  hId: string,
  dateStr: string,
  onData: (summary: TodaySummary | null) => void,
  onError?: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db, todaySummaryPath(hId, dateStr)),
    snap => onData(snap.exists() ? (snap.data() as TodaySummary) : null),
    err => onError?.(err),
  )
}

// ── Restock requests ────────────────────────────────────────

// Live subscription for the admin Cabinet's "Restock requests" card.
// No orderBy in the query (would need a composite index with the where);
// we sort client-side by requestedAt desc — pending lists are tiny.
export function subscribeRestockRequests(
  hId: string,
  onData: (requests: RestockRequest[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const q = query(
    collection(db, restockRequestsCollectionPath(hId)),
    where('status', '==', 'pending'),
  )
  return onSnapshot(
    q,
    snap => {
      const list = snap.docs.map(d => d.data() as RestockRequest)
      list.sort((a, b) => {
        const am = a.requestedAt?.toMillis() ?? 0
        const bm = b.requestedAt?.toMillis() ?? 0
        return bm - am
      })
      onData(list)
    },
    err => onError?.(err),
  )
}

export async function updateRestockRequest(
  hId: string,
  requestId: string,
  status: 'fulfilled' | 'dismissed',
): Promise<void> {
  await updateDoc(doc(db, restockRequestPath(hId, requestId)), {
    status,
    resolvedAt: serverTimestamp(),
  })
}

// ── Treatment lifecycle (admin actions) ─────────────────────

// Marks a treatment paused and appends a new pauseHistory entry. Uses
// Timestamp.now() inside the array element because Firestore disallows
// FieldValue.serverTimestamp() inside arrayUnion values.
export async function pauseTreatment(
  hId: string,
  tId: string,
  currentUid: string,
): Promise<void> {
  const entry: PauseEntry = {
    pausedAt: Timestamp.now(),
    resumedAt: null,
    pausedBy: currentUid,
  }
  await updateDoc(doc(db, treatmentPath(hId, tId)), {
    status: 'paused',
    updatedAt: serverTimestamp(),
    pauseHistory: arrayUnion(entry),
  })
}

// Resumes the treatment and stamps the latest open pauseHistory entry's
// resumedAt. Read-modify-write of the array, so wrap in a transaction to
// avoid lost updates if a parallel pause/resume races.
export async function resumeTreatment(
  hId: string,
  tId: string,
): Promise<void> {
  const ref = doc(db, treatmentPath(hId, tId))
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new Error('Treatment not found')
    const data = snap.data() as Treatment
    const history = data.pauseHistory ?? []
    let nextHistory: PauseEntry[] | undefined
    if (history.length > 0) {
      const last = history[history.length - 1]
      if (!last.resumedAt) {
        nextHistory = history.slice(0, -1).concat({
          ...last,
          resumedAt: Timestamp.now(),
        })
      }
    }
    const update: Record<string, unknown> = {
      status: 'active',
      updatedAt: serverTimestamp(),
    }
    if (nextHistory) update.pauseHistory = nextHistory
    tx.update(ref, update)
  })
}

export async function endTreatment(
  hId: string,
  tId: string,
): Promise<void> {
  await updateDoc(doc(db, treatmentPath(hId, tId)), {
    status: 'completed',
    endDate: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}


// ── Batch 3 additions ────────────────────────────────────────

// Loads dose logs whose scheduledDate falls within [fromDate, toDate]
// (inclusive, ISO YYYY-MM-DD). Iterates treatments because a collectionGroup
// query on `logs` would need a composite index per env. Includes paused +
// completed treatments — history should not vanish when a treatment ends.
export async function loadLogsForDateRange(
  hId: string,
  fromDate: string,
  toDate: string,
): Promise<DoseLog[]> {
  const treatsSnap = await getDocs(collection(db, treatmentsCollectionPath(hId)))
  const all: DoseLog[] = []
  await Promise.all(treatsSnap.docs.map(async tDoc => {
    const treat = tDoc.data() as Treatment
    const logsSnap = await getDocs(query(
      collection(db, dosesCollectionPath(hId, treat.tId)),
      where("scheduledDate", ">=", fromDate),
      where("scheduledDate", "<=", toDate),
    ))
    for (const ld of logsSnap.docs) all.push(ld.data() as DoseLog)
  }))
  return all
}

// Loads every regimen for active treatments in the household, grouped by tId.
// Used by the Treatments adherence calc and the DoseHistory missed-dose
// inference; piggybacks on existing collection structure with no new indexes.
export async function loadAllActiveRegimens(
  hId: string,
): Promise<{ treatments: Treatment[]; regimensByTreatment: Record<string, Regimen[]> }> {
  const treatsSnap = await getDocs(query(
    collection(db, treatmentsCollectionPath(hId)),
    where("status", "==", "active"),
  ))
  const treatments = treatsSnap.docs.map(d => d.data() as Treatment)
  const regimensByTreatment: Record<string, Regimen[]> = {}
  await Promise.all(treatments.map(async t => {
    const regSnap = await getDocs(collection(db, regimensCollectionPath(hId, t.tId)))
    regimensByTreatment[t.tId] = regSnap.docs.map(d => d.data() as Regimen)
  }))
  return { treatments, regimensByTreatment }
}

// Member-initiated restock nudge. Writes a single immutable doc that the
// admin can read; rules deny update/delete so the audit trail is preserved.
// `quantityAtRequest` is captured at request time so that a later top-up
// doesn't rewrite history if the admin reviews older requests.
export async function createRestockRequest(
  hId: string,
  args: {
    cabinetItemId: string
    medicineName: string
    requestedBy: string
    quantityAtRequest: number
  },
): Promise<string> {
  const requestId = crypto.randomUUID()
  await setDoc(doc(db, `households/${hId}/restockRequests/${requestId}`), {
    requestId,
    cabinetItemId: args.cabinetItemId,
    medicineName: args.medicineName,
    requestedBy: args.requestedBy,
    requestedAt: serverTimestamp(),
    status: 'pending',
    quantityAtRequest: args.quantityAtRequest,
  })
  return requestId
}

// ── DPDP consent (MC-017a) ──────────────────────────────────

// Reads consentLog/{uid} so App.tsx can decide whether to gate the user
// behind ConsentScreen. Returns null when the doc does not exist (first
// sign-in) or is unreadable (offline/permissions).
export async function getConsentRecord(uid: string): Promise<ConsentRecord | null> {
  const snap = await getDoc(doc(db, consentLogPath(uid)))
  if (!snap.exists()) return null
  return snap.data() as ConsentRecord
}

// Writes a single immutable consentLog/{uid} doc. The rules block update
// and delete, so a re-consent (after a policy bump) overwrites via setDoc
// — which the rules treat as a create when the prior doc had a different
// policyVersion is NOT possible, so we set merge:true for that path. For
// MVP the policy bump path simply replaces the doc by issuing a new uid
// is unchanged, so we use setDoc without merge here. The recordConsent
// flow is gated by App.tsx detecting an outdated policyVersion.
export async function recordConsent(uid: string, platform: string): Promise<void> {
  const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || 'dev'
  await setDoc(doc(db, consentLogPath(uid)), {
    uid,
    consentedAt: serverTimestamp(),
    policyVersion: CURRENT_POLICY_VERSION,
    appVersion,
    platform,
  })
}

// Self-service preference write. Only the fields explicitly allowed by the
// security rules can land here; passing anything else will be denied at write.
export async function updateUserPreferences(
  uid: string,
  prefs: Partial<{
    languagePref: string
    pushNotificationsEnabled: boolean
    whatsappRemindersEnabled: boolean
    reminderMethod: 'whatsapp' | 'push' | 'both'
  }>,
): Promise<void> {
  await setDoc(doc(db, userPath(uid)), prefs, { merge: true })
}
