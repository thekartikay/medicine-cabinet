// AK-176 — Firestore SDK is no longer a top-level value import. Every
// Firestore primitive (doc, collection, getDoc, ..., Timestamp, ...) and the
// db instance come from getFirestoreContext() at the call site. That keeps
// the @firebase/firestore SDK out of the entry bundle (Vite chunk-splits it)
// and ensures initializeFirestore + persistentLocalCache run exactly once,
// memoized inside the context. No type-only import of firebase/firestore is
// needed here — every Timestamp reference is a runtime value destructured
// from the context inside the function body that uses it.
import { updateProfile, type User as FirebaseUser } from 'firebase/auth'
import { getFirestoreContext } from '../lib/firebase'
import {
  userPath,
  householdPath,
  memberPath,
  cabinetPath,
  itemPath,
  itemEventPath,
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
  addressesCollectionPath,
  addressPath,
  pendingInviteDoc,
  todaySummaryPath,
  consentVersionPath,
  CURRENT_POLICY_VERSION,
  buildSlotId,
  todayISTString,
} from '../lib/paths'
import type {
  Address,
  AppUser,
  CabinetItem,
  CabinetItemUnit,
  ConsentRecord,
  DosageForm,
  DoseLog,
  DoseSlotDisplay,
  DoseStatus,
  Household,
  HouseholdMember,
  MasterMedicine,
  Notification,
  PauseEntry,
  PendingInvite,
  Regimen,
  RestockRequest,
  ScheduleType,
  SkipReasonId,
  StockSource,
  TimeSlot,
  TodaySummary,
  Treatment,
  TreatmentCategory,
} from '../types'

export async function createUserIfNew(user: FirebaseUser): Promise<void> {
  const { db, doc, getDoc, setDoc, serverTimestamp } = await getFirestoreContext()
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
  const { db, doc, getDoc } = await getFirestoreContext()
  const snap = await getDoc(doc(db, userPath(uid)))
  if (!snap.exists()) return null
  return snap.data() as AppUser
}

// AK-117 — Updates fields on users/{uid}. Used by ProfileSetup to persist the
// name the user typed after sign-in, and reusable for future profile edits.
// Merge keeps fields the caller didn't pass (e.g. createdAt, householdId).
export async function updateUserProfile(
  uid: string,
  updates: { displayName?: string; phone?: string; email?: string },
): Promise<void> {
  const { db, doc, setDoc, serverTimestamp } = await getFirestoreContext()
  await setDoc(
    doc(db, userPath(uid)),
    { ...updates, updatedAt: serverTimestamp() },
    { merge: true },
  )
}

// AK-161 — Single entry point for renaming the current user. The displayName
// lives in three places (Firebase Auth, users/{uid}, and the denormalised copy
// on households/{hId}/members/{uid}); the Profile screen has to update all
// three or the roster and "Updated by …" displays drift. hId is nullable for
// the rare case of a user without a household (e.g. mid-onboarding). Fails
// fast: a partial failure is surfaced to the caller so the user can retry,
// rather than silently leaving the three copies inconsistent.
export async function updateDisplayNameEverywhere(
  uid: string,
  hId: string | null,
  user: FirebaseUser,
  displayName: string,
): Promise<void> {
  const trimmed = displayName.trim()
  if (!trimmed) throw new Error('Display name cannot be empty')

  // Each delegate-call awaits getFirestoreContext() internally; no direct
  // Firestore primitives needed here.
  await Promise.all([
    updateProfile(user, { displayName: trimmed }),
    updateUserProfile(uid, { displayName: trimmed }),
    hId ? syncMemberDisplayName(hId, uid, trimmed) : Promise.resolve(),
  ])
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
  const { db, doc, getDoc } = await getFirestoreContext()
  const snap = await getDoc(doc(db, householdPath(hId)))
  if (!snap.exists()) return null
  const data = snap.data()
  return { hId: data['hId'] as string, name: data['name'] as string }
}

// Returns the cId of the household's default cabinet, creating it if it doesn't exist.
// Uses a deterministic cId (`${hId}-default`) so concurrent calls are idempotent.
export async function getOrCreateDefaultCabinet(hId: string): Promise<string> {
  const { db, doc, getDoc, setDoc, serverTimestamp } = await getFirestoreContext()
  const cId = `${hId}-default`
  const ref = doc(db, cabinetPath(hId, cId))
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    await setDoc(ref, { cId, hId, name: 'Main Cabinet', createdAt: serverTimestamp() })
  }
  return cId
}

export async function getCabinetItems(hId: string, cId: string): Promise<CabinetItem[]> {
  const { db, collection, getDocs } = await getFirestoreContext()
  const snap = await getDocs(collection(db, itemsCollectionPath(hId, cId)))
  // AK-150 — Client-side filter for soft-deleted items. Truthy disposedAt
  // (any Timestamp) is excluded; undefined and null both pass through.
  return snap.docs
    .map(d => d.data() as CabinetItem)
    .filter(i => !i.disposedAt)
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
    // AK-151 — Stable masterDb doc id when the item came from a catalog
    // pick (AK-128 masterLocked path). Null/absent for free-text adds.
    masterDbId?: string | null
  },
): Promise<string> {
  const { db, doc, setDoc, serverTimestamp } = await getFirestoreContext()
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

// AK-39 — Stamps the passive interaction warning on a cabinet item. Called
// in the background after addCabinetItem, never inside a transaction. Pass
// null to clear an existing warning. `checkedAt` is set server-side
// (serverTimestamp) so the caller does not need to provide a Timestamp.
//
// Security: the cabinet-items rule only permits admins to write fields
// outside the dose-debit whitelist. Since only admins can call
// addCabinetItem in the first place, this update path is admin-only too.
export async function updateCabinetItemInteractionWarning(
  hId: string,
  cId: string,
  iId: string,
  warning:
    | Omit<NonNullable<CabinetItem['interactionWarning']>, 'checkedAt'>
    | null,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  await updateDoc(doc(db, itemPath(hId, cId, iId)), {
    interactionWarning:
      warning === null
        ? null
        : { ...warning, checkedAt: serverTimestamp() },
    updatedAt: serverTimestamp(),
  })
}

// AK-151 — Update a manually-added cabinet item from the detail-sheet
// Edit flow. Restricted field set: only the values the edit form exposes
// (brand/strength/dosage form/unit/quantity/expiry plus the optional
// displayNameOverride). Anything else — masterDbId, prescribed,
// medicineId, interactionWarning, createdAt, the enrichment-only fields
// — is intentionally not accepted to keep this path narrow. updatedAt
// is always stamped server-side. The grouping key (medicineId,
// strength, prescribed) is partially mutable here: editing strength
// will move the item between groups in the Cabinet list, which is
// intentional (a 500mg → 650mg correction should re-bucket).
export async function updateCabinetItem(
  hId: string,
  cId: string,
  iId: string,
  updates: {
    displayNameOverride?: string | null
    brandName?: string | null
    strength?: string | null
    dosageForm?: DosageForm | null
    unit?: CabinetItemUnit
    quantityOnHand?: number
    expiryDate?: string | null
  },
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  await updateDoc(doc(db, itemPath(hId, cId, iId)), {
    ...updates,
    updatedAt: serverTimestamp(),
  })
}

// AK-124 — Hard-delete a cabinet item. Used by the treatment-interaction
// warning modal's "Remove from cabinet" action to undo a just-added item
// that conflicts with a household member's active treatment. Admin-only at
// the rules layer (allow delete: if isAdmin(hId)).
//
// AK-150 — User-initiated batch / medicine deletion now uses the soft-delete
// disposeCabinetItem below. This hard delete stays in place because the
// AK-124 case is a true undo of a doc that was just written seconds ago —
// no dose logs yet reference it, and the user expects the row to vanish
// rather than be filtered out.
//
// Note: existing dose logs that reference this iId stay in place — the dose
// log is its own historical record and isn't garbage-collected when the
// cabinet item it points at goes away. The audit reconciliation view (when
// that ships) needs to tolerate dangling cabinetItemId references.
export async function deleteCabinetItem(
  hId: string,
  cId: string,
  iId: string,
): Promise<void> {
  const { db, doc, deleteDoc } = await getFirestoreContext()
  await deleteDoc(doc(db, itemPath(hId, cId, iId)))
}

// AK-150 — Soft-delete a cabinet item. Stamps disposedAt; subscribeCabinetItems
// and getCabinetItems filter the item out of all UI consumers from that point.
// The doc itself is preserved so dose logs referencing this iId still resolve
// against a real document (matters for the audit reconciliation view and any
// "Updated by" / "Used in" lookups that may need to display a disposed-batch
// label rather than a dangling reference).
export async function disposeCabinetItem(
  hId: string,
  cId: string,
  iId: string,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  await updateDoc(doc(db, itemPath(hId, cId, iId)), {
    disposedAt: serverTimestamp(),
  })
}

// AK-174 — Increment a cabinet item's quantityOnHand and write a matching
// append-only event row at items/{iId}/events/{eventId}, in one transaction.
//
// Why a transaction (not updateDoc): read-modify-write on a counter must be
// race-safe against concurrent dose debits (logDose). Mirrors the shape of
// logDose's debit and the zeroCabinetItemStock Cloud Function helper.
//
// Why the event doc: the source of an increment (manual_add / future API
// delivery / seed) is auditable history. The item doc holds state; events
// hold the trail. Both writes are atomic — if either fails, both roll back.
//
// The item update touches only `quantityOnHand` + `updatedAt`, which keeps it
// within the existing member rule allowlist (onlyChanges(...)) — no rule
// widening required. Expiry from the add-stock modal lives on the event row,
// not on the item (beta simplification; multi-batch expiry is its own ticket).
export async function addStock(
  hId: string,
  cId: string,
  iId: string,
  args: {
    amount: number
    source: StockSource
    actorUid: string
    actorRole: 'admin' | 'member'
    batchNumber?: string | null
    expiryDate?: string | null
    notes?: string | null
  },
): Promise<void> {
  if (!(args.amount > 0)) {
    throw new Error('Stock amount must be greater than zero.')
  }
  // Defensive clamp — UI also limits to 200 chars, but a runtime guard keeps
  // the event row predictable regardless of caller.
  const notesClamped = args.notes ? args.notes.slice(0, 200) : null
  const eventId = crypto.randomUUID()

  const { db, doc, runTransaction, serverTimestamp } = await getFirestoreContext()
  await runTransaction(db, async tx => {
    const itemRef = doc(db, itemPath(hId, cId, iId))
    const itemSnap = await tx.get(itemRef)
    if (!itemSnap.exists()) {
      throw new Error('Cabinet item not found.')
    }
    const item = itemSnap.data() as CabinetItem
    if (item.disposedAt) {
      throw new Error('Cannot add stock to a deleted medicine.')
    }

    const quantityBefore = item.quantityOnHand
    const quantityAfter = quantityBefore + args.amount

    // Item update — stays within the member rules allowlist
    // (firestore.rules onlyChanges(['quantityOnHand', 'updatedAt'])).
    tx.update(itemRef, {
      quantityOnHand: quantityAfter,
      updatedAt: serverTimestamp(),
    })

    // Append-only event row capturing the source + delta + before/after.
    const eventRef = doc(db, itemEventPath(hId, cId, iId, eventId))
    tx.set(eventRef, {
      eventId,
      iId,
      cId,
      hId,
      type: 'increment' as const,
      delta: args.amount,
      source: args.source,
      quantityBefore,
      quantityAfter,
      actorUid: args.actorUid,
      actorRole: args.actorRole,
      batchNumber: args.batchNumber ?? null,
      expiryDate: args.expiryDate ?? null,
      notes: notesClamped,
      at: serverTimestamp(),
    })
  })
}

// AK-176 — Subscription pattern. The cancelled flag is load-bearing: if the
// caller's cleanup runs before getFirestoreContext() resolves (e.g. an effect
// unmounts during init), we never attach the listener. The returned
// unsubscribe stays synchronous so every calling useEffect is unchanged.
export function subscribeCabinetItems(
  hId: string,
  cId: string,
  onData: (items: CabinetItem[]) => void,
  onError?: (error: Error) => void,
): () => void {
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, onSnapshot }) => {
      if (cancelled) return
      realUnsub = onSnapshot(
        collection(db, itemsCollectionPath(hId, cId)),
        // AK-150 — Same filter as getCabinetItems; keeps disposed items out of
        // every consumer's `items` state.
        snap => onData(
          snap.docs
            .map(d => d.data() as CabinetItem)
            .filter(i => !i.disposedAt),
        ),
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeCabinetItems: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

// AK-125 — Case-insensitive prefix search against the masterDb catalogue.
// The Firestore index is on `nameLower` (lowercased copy of `name`), so the
// user typing "metformin", "Metformin", or "METFORMIN" all hit the same
// prefix bucket. Returns the raw MasterMedicine — the display name field
// is still `name`, not `nameLower`; the lowercased field is query-only.
export async function searchMasterDb(queryStr: string): Promise<MasterMedicine[]> {
  const trimmed = queryStr.trim()
  if (!trimmed) return []
  const queryLower = trimmed.toLowerCase()
  const { db, collection, query, where, limit, getDocs } = await getFirestoreContext()
  const q = query(
    collection(db, 'masterDb'),
    where('nameLower', '>=', queryLower),
    where('nameLower', '<', queryLower + ''),
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
  // AK-131 — flexible-daily carries no fixed times; the list view uses this
  // string verbatim on the Treatments list card.
  if (scheduleType === "flexible-daily") return "Once a day, any time"
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
  const { db, doc, setDoc, serverTimestamp } = await getFirestoreContext()
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

// AK-39 sub-task 2 — Collects the cabinet items currently driving active
// treatments for a given member. Used by the treatment-create flow to
// pre-check interactions when the user picks a new medicine for that member.
//
// Returns one entry per regimen on each active treatment (a treatment can
// have multiple regimens; each pins one cabinet item). The shape is
// intentionally narrow — only the fields the interaction check needs.
//
// Fails silently: any read error returns []. The interaction check is a
// soft UX nudge, never load-bearing for the create flow.
export async function getActiveTreatmentMedicines(
  hId: string,
  memberId: string,
): Promise<Array<{ cabinetItemId: string; displayName: string; medicineId: string }>> {
  try {
    const { db, collection, query, where, getDocs } = await getFirestoreContext()
    const treatments = await getDocs(
      query(
        collection(db, treatmentsCollectionPath(hId)),
        where('memberId', '==', memberId),
        where('status', '==', 'active'),
      ),
    )
    const out: Array<{ cabinetItemId: string; displayName: string; medicineId: string }> = []
    for (const tDoc of treatments.docs) {
      const tId = tDoc.id
      const regimens = await getDocs(
        collection(db, regimensCollectionPath(hId, tId)),
      )
      for (const rDoc of regimens.docs) {
        const r = rDoc.data() as Regimen
        if (!r.cabinetItemId) continue
        out.push({
          cabinetItemId: r.cabinetItemId,
          displayName: r.displayName,
          medicineId: r.medicineId,
        })
      }
    }
    return out
  } catch {
    return []
  }
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
    // PRN safety cap. Only set when scheduleType === 'as-needed'. Spread
    // via ...data into the regimen doc, so when undefined no field is
    // written (older PRN regimens stay unfielded → treated as no limit).
    maxDosesPerDay?: number
    // AK-171 — IANA timezone denormalized from the patient's member doc.
    // Caller resolves the value; the cron reads it directly off the regimen
    // to decide when slots fire. Optional during the AK-171 rollout: pre-AK-171
    // regimens carry no timezone field and the cron defaults to 'Asia/Kolkata'.
    timezone?: string
  },
): Promise<string> {
  const { db, doc, writeBatch, serverTimestamp } = await getFirestoreContext()
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
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, onSnapshot }) => {
      if (cancelled) return
      realUnsub = onSnapshot(
        collection(db, treatmentsCollectionPath(hId)),
        snap => onData(snap.docs.map(d => d.data() as Treatment)),
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeTreatments: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

export async function getHouseholdMembers(hId: string): Promise<HouseholdMember[]> {
  const { db, collection, getDocs } = await getFirestoreContext()
  const snap = await getDocs(collection(db, membersCollectionPath(hId)))
  return snap.docs.map(d => d.data() as HouseholdMember)
}

// AK-166 — Pre-stage an invite the admin issued for a yet-to-join member.
// joinHousehold reads this doc, validates phoneE164 against the joining user's
// Firebase Auth phone number, and copies memberName + languagePref onto the
// new member doc. Returns the inviteId so the admin UI can include it in a
// deep link (Piece C).
export async function createPendingInvite(
  hId: string,
  data: {
    phoneE164: string
    memberName: string
    languagePref: string
    createdBy: string
  },
): Promise<string> {
  const { db, doc, setDoc, Timestamp } = await getFirestoreContext()
  const inviteId = crypto.randomUUID()
  const now = Timestamp.now()
  const expiresAt = Timestamp.fromMillis(now.toMillis() + 7 * 24 * 60 * 60 * 1000)
  const invite: PendingInvite = {
    inviteId,
    hId,
    phoneE164: data.phoneE164,
    memberName: data.memberName,
    languagePref: data.languagePref as PendingInvite['languagePref'],
    createdBy: data.createdBy,
    createdAt: now,
    expiresAt,
    status: 'pending',
    redeemedBy: null,
    redeemedAt: null,
  }
  await setDoc(doc(db, pendingInviteDoc(hId, inviteId)), invite)
  return inviteId
}

// Convenience: resolves the household default cabinet and returns its items.
export async function getDefaultCabinetItems(hId: string): Promise<CabinetItem[]> {
  // Both delegates await getFirestoreContext() internally.
  const cId = await getOrCreateDefaultCabinet(hId)
  return getCabinetItems(hId, cId)
}

// Computes today applicable dose slots from active treatments and their regimens.
// Client-side fallback — the canonical source is todaySummary/{date} written by Cloud Functions.
export async function loadTodaysDoses(hId: string): Promise<DoseSlotDisplay[]> {
  const { db, collection, query, where, getDocs } = await getFirestoreContext()
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

      // AK-131 — flex regimens carry no fixed slots; emit one synthetic
      // dose anchored at 09:00 IST. Mirrors the Cloud Function slotId.
      if (reg.scheduleType === 'flexible-daily') {
        all.push({
          treatmentId: treat.tId,
          treatmentName: treat.name,
          memberName: treat.memberName,
          medicineName: reg.displayName,
          doseAmount: reg.doseAmount,
          doseUnit: reg.doseUnit,
          time: '09:00',
          foodTiming: 'after',
          regimenId: reg.rId,
          slotId: `${treat.tId}-${reg.rId}-${treat.memberId}-${today}-flex`,
          patientId: treat.memberId,
          cabinetItemId: reg.cabinetItemId,
          scheduleType: 'flexible-daily',
        })
        continue
      }

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
  const { db, collection, query, where, getDocs } = await getFirestoreContext()
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
    // AK-154 — structured skip reason id (was free-text). 'other' pairs with
    // skipReasonText for the user's own words (max 120 chars, enforced by UI).
    skipReason?: SkipReasonId | null
    skipReasonText?: string | null
    lateNote?: string | null
    // AK-154 — for status 'late', the actual instant the dose was taken
    // ("Just now" or an earlier-today time). Written as a Timestamp so the
    // log records when the dose was really taken, not when it was logged.
    // Ignored for non-late statuses (those stamp serverTimestamp()).
    takenAt?: Date | null
    createdBy: string
    // AK-131 — When 'flexible-daily', the slotId carries a `-flex` suffix
    // instead of the HHmm tail so it pairs with the synthetic slot
    // maintainTodaySummary writes. Caller should still pass scheduledTime
    // as the 09:00 IST anchor so scheduledAt + audit-fence behaviour stays
    // consistent with fixed-time slots. Any other value (or absent) falls
    // through the standard HHmm path.
    scheduleType?: ScheduleType
  },
): Promise<{
  slotId: string
  inventoryDebited: boolean
  alreadyLogged: boolean
  inventoryClamped: boolean
  actualDebit: number
}> {
  const cId = await getOrCreateDefaultCabinet(hId)
  const slotId = args.scheduleType === 'flexible-daily'
    ? `${args.tId}-${args.rId}-${args.patientId}-${args.scheduledDate}-flex`
    : buildSlotId(
        args.tId, args.rId, args.patientId,
        args.scheduledDate, args.scheduledTime.replace(":", ""),
      )
  const scheduledAt = new Date(`${args.scheduledDate}T${args.scheduledTime}:00+05:30`)

  const { db, doc, runTransaction, serverTimestamp, Timestamp } = await getFirestoreContext()
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
      return {
        slotId,
        inventoryDebited: existing.inventoryDebited,
        alreadyLogged: true,
        inventoryClamped: false,
        actualDebit: 0,
      }
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

    // Bug #3 — capture both the clamp signal and the actual physical
    // decrement that lands on quantityOnHand. The transaction never writes a
    // negative quantity (Math.max guards that), but when stock < dose the
    // log records what we *could* debit so audit reconciliation isn't
    // silently inconsistent.
    let newQty = 0
    let inventoryClamped = false
    let actualDebit = 0
    if (debitsInventory) {
      const item = itemSnap.data() as CabinetItem
      actualDebit = Math.min(item.quantityOnHand, args.doseAmount)
      inventoryClamped = item.quantityOnHand < args.doseAmount
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
      // AK-154 — a late take records the instant the dose was actually taken
      // (caller-supplied Date); everything else stamps when the log was written.
      takenAt:
        args.status === 'late' && args.takenAt
          ? Timestamp.fromDate(args.takenAt)
          : serverTimestamp(),
      skipReason: args.skipReason ?? null,
      skipReasonText: args.skipReasonText ?? null,
      // Stamped by the onLogWritten Cloud Function after the caregiver FCM fires.
      caregiverNotifiedAt: null,
      lateNote: args.lateNote ?? null,
      doseAmount: args.doseAmount,
      doseUnit: args.doseUnit,
      cabinetItemId: args.cabinetItemId,
      inventoryDebited: debitsInventory,
      inventoryClamped,
      actualDebit,
      createdBy: args.createdBy,
      createdAt: serverTimestamp(),
    })

    if (debitsInventory) {
      tx.update(itemRef, {
        quantityOnHand: newQty,
        updatedAt: serverTimestamp(),
      })
    }

    return {
      slotId,
      inventoryDebited: debitsInventory,
      alreadyLogged: false,
      inventoryClamped,
      actualDebit,
    }
  })
}

// AK-137 — Count today's logs for a single PRN regimen. Drives the
// "Taken today: N / cap" display and the disable-at-cap gate on the
// dashboard's As-needed section. Cheap one-read per regimen — PRN logs
// per regimen per day are bounded by maxDosesPerDay, which is single
// digits in practice.
export async function getPrnDosesToday(
  hId: string,
  tId: string,
  rId: string,
  dateStr: string,
): Promise<number> {
  const { db, collection, query, where, getDocs } = await getFirestoreContext()
  const q = query(
    collection(db, dosesCollectionPath(hId, tId)),
    where('rId', '==', rId),
    where('scheduledDate', '==', dateStr),
  )
  const snap = await getDocs(q)
  return snap.size
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
    // AK-131 — Same `-flex` slotId switch as logDose. See that function
    // for the design rationale.
    scheduleType?: ScheduleType
  },
): Promise<{
  slotId: string
  inventoryDebited: boolean
  alreadyLogged: boolean
  inventoryClamped: boolean
  actualDebit: number
}> {
  const cId = await getOrCreateDefaultCabinet(hId)
  const slotId = args.scheduleType === 'flexible-daily'
    ? `${args.tId}-${args.rId}-${args.patientId}-${args.scheduledDate}-flex`
    : buildSlotId(
        args.tId, args.rId, args.patientId,
        args.scheduledDate, args.scheduledTime.replace(":", ""),
      )
  const scheduledAt = new Date(`${args.scheduledDate}T${args.scheduledTime}:00+05:30`)

  const ctx = await getFirestoreContext()
  const { db, doc, runTransaction, setDoc, serverTimestamp, Timestamp } = ctx
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
      return {
        slotId,
        inventoryDebited: existing.inventoryDebited,
        alreadyLogged: true,
        inventoryClamped: false,
        actualDebit: 0,
      }
    }
    const previouslyDebited = existing?.inventoryDebited ?? false

    const household = householdSnap.data() as Household
    const lastAuditAt = household.lastAuditAt
    const auditFenced = lastAuditAt != null && scheduledAt.getTime() < lastAuditAt.toMillis()

    const debitsInventory = !auditFenced && itemSnap.exists() && !previouslyDebited

    // Bug #3 — same clamp telemetry as logDose. The admin-override path
    // hits the same under-debit edge case when stock < dose.
    let newQty = 0
    let inventoryClamped = false
    let actualDebit = 0
    if (debitsInventory) {
      const item = itemSnap.data() as CabinetItem
      actualDebit = Math.min(item.quantityOnHand, args.doseAmount)
      inventoryClamped = item.quantityOnHand < args.doseAmount
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
      inventoryClamped,
      actualDebit,
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

    return {
      slotId,
      inventoryDebited: debitsInventory,
      alreadyLogged: false,
      inventoryClamped,
      actualDebit,
    }
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
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, query, where, orderBy, limit, onSnapshot, Timestamp }) => {
      if (cancelled) return
      // 30-day window keeps the panel feed bounded. Single-field where + orderBy
      // on createdAt is auto-indexed; no firestore.indexes.json change needed.
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const q = query(
        collection(db, notificationsCollectionPath(hId)),
        where('createdAt', '>=', Timestamp.fromDate(cutoff)),
        orderBy('createdAt', 'desc'),
        limit(50),
      )
      realUnsub = onSnapshot(
        q,
        snap => onData(snap.docs.map(d => d.data() as Notification)),
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeNotifications: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

export async function markNotificationRead(
  hId: string,
  notifId: string,
  uid: string,
): Promise<void> {
  const { db, doc, updateDoc, arrayUnion } = await getFirestoreContext()
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
  const { db, doc, writeBatch, arrayUnion } = await getFirestoreContext()
  const batch = writeBatch(db)
  for (const n of unread) {
    batch.update(doc(db, notificationPath(hId, n.notifId)), {
      readBy: arrayUnion(uid),
    })
  }
  await batch.commit()
}

// AK-153 — Fire-and-forget self-heal write. Called from App.tsx after
// auth + household resolution when the loaded member doc has a null
// displayName but the Firebase Auth user does carry one (typical for a
// pre-AK-117 phone-OTP user who later completed ProfileSetup but whose
// member doc was stamped before that — the denormalized copy never got
// re-synced). Idempotent: callers gate on the null check, but a duplicate
// write is harmless.
export async function syncMemberDisplayName(
  hId: string,
  uid: string,
  displayName: string,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  await updateDoc(doc(db, memberPath(hId, uid)), {
    displayName,
    updatedAt: serverTimestamp(),
  })
}

// Look up a household member's displayName. Used by Dashboard's "Updated by
// [name]" lookup — the users/{uid} collection's read rule is self-only, so
// we read from the household's members subcollection (read: isParticipant).
export async function getMemberDisplayName(
  hId: string,
  uid: string,
): Promise<string | null> {
  const { db, doc, getDoc } = await getFirestoreContext()
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
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, doc, onSnapshot }) => {
      if (cancelled) return
      realUnsub = onSnapshot(
        doc(db, todaySummaryPath(hId, dateStr)),
        snap => onData(snap.exists() ? (snap.data() as TodaySummary) : null),
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeTodaySummary: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
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
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, query, where, onSnapshot }) => {
      if (cancelled) return
      const q = query(
        collection(db, restockRequestsCollectionPath(hId)),
        where('status', '==', 'pending'),
      )
      realUnsub = onSnapshot(
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
    })
    .catch(err => {
      console.warn('subscribeRestockRequests: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

export async function updateRestockRequest(
  hId: string,
  requestId: string,
  status: 'fulfilled' | 'dismissed',
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
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
  const { db, doc, updateDoc, serverTimestamp, arrayUnion, Timestamp } = await getFirestoreContext()
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
  const { db, doc, runTransaction, serverTimestamp, Timestamp } = await getFirestoreContext()
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
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  await updateDoc(doc(db, treatmentPath(hId, tId)), {
    status: 'completed',
    endDate: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

// AK-138 — Narrow treatment-level edit. The whitelist is intentionally
// tight: only `name` is exposed today. Adding more fields here requires a
// matching rules-allowlist update plus an onTreatmentWritten guard review,
// since most other treatment fields (status, endDate, pauseHistory) have
// dedicated transactions that own their write surface.
export async function updateTreatment(
  hId: string,
  tId: string,
  updates: { name?: string },
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  const payload: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  }
  if (updates.name !== undefined) payload.name = updates.name
  await updateDoc(doc(db, treatmentPath(hId, tId)), payload)
}

// AK-138 — Narrow regimen-level edit. doseAmount/endDate/ongoing are the
// only fields the edit sheet exposes today. Mid-day edits flow through to
// the dashboard via the onRegimenWritten trigger which rebuilds today's
// summary. Existing dose logs are NOT rewritten — each log captured its
// own historical doseAmount at write time and stays as the source of truth
// for that slot's history.
export async function updateRegimen(
  hId: string,
  tId: string,
  rId: string,
  updates: {
    doseAmount?: number
    endDate?: string | null
    ongoing?: boolean
    // AK-130 — schedule-shape fields. Presence of any of these marks the edit
    // as a schedule change (stamps scheduleChangedAt → maintainTodaySummary
    // defers it to tomorrow). slots/scheduleDays apply to fixed-time regimens;
    // maxDosesPerDay applies to PRN (as-needed).
    slots?: TimeSlot[]
    scheduleDays?: number[] | null
    maxDosesPerDay?: number
  },
): Promise<void> {
  // Defence in depth: these define the regimen's identity/anchor and must
  // never change via an edit. TypeScript already excludes them from the
  // updates shape; this strips any that leak in through an untyped caller.
  const raw = updates as Record<string, unknown>
  for (const k of ['scheduleType', 'startDate', 'cabinetItemId', 'medicineId', 'displayName']) {
    if (k in raw) {
      console.warn(`updateRegimen: stripping disallowed field "${k}"`)
      delete raw[k]
    }
  }

  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  const payload: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  }
  if (updates.doseAmount !== undefined) payload.doseAmount = updates.doseAmount
  if (updates.endDate !== undefined) payload.endDate = updates.endDate
  if (updates.ongoing !== undefined) payload.ongoing = updates.ongoing
  if (updates.slots !== undefined) payload.slots = updates.slots
  if (updates.scheduleDays !== undefined) payload.scheduleDays = updates.scheduleDays
  if (updates.maxDosesPerDay !== undefined) payload.maxDosesPerDay = updates.maxDosesPerDay

  // AK-130 — any slot-structure change defers to tomorrow via this marker.
  const isScheduleChange =
    updates.slots !== undefined ||
    updates.scheduleDays !== undefined ||
    updates.maxDosesPerDay !== undefined
  if (isScheduleChange) {
    payload.scheduleChangedAt = serverTimestamp()
  }

  await updateDoc(doc(db, regimenPath(hId, tId, rId)), payload)
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
  const { db, collection, query, where, getDocs } = await getFirestoreContext()
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
// AK-123 — Active treatments for one member, paired with their regimens.
// Reuses loadAllActiveRegimens under the hood (active-status filter + regimen
// fan-out) and JS-filters by memberId. Used by the step 3 → step 4 conflict
// check in the treatment-create wizard, which compares date ranges per
// medicineId. Fails silently: any read error returns [] so the conflict
// check stays a soft UX gate, never load-bearing for the create flow.
export async function getActiveTreatmentsWithRegimensForMember(
  hId: string,
  memberId: string,
): Promise<Array<{ treatment: Treatment; regimens: Regimen[] }>> {
  try {
    // loadAllActiveRegimens awaits getFirestoreContext() internally.
    const { treatments, regimensByTreatment } = await loadAllActiveRegimens(hId)
    return treatments
      .filter(t => t.memberId === memberId && t.status === 'active')
      .map(t => ({ treatment: t, regimens: regimensByTreatment[t.tId] ?? [] }))
  } catch {
    return []
  }
}

// AK-121 — Bulk-write retroactive dose logs when the admin chooses to log
// past doses on a treatment whose start date is in the past. Each log is a
// real DoseLog (full required-field shape) so downstream consumers
// (Dashboard, DoseHistory, audit reconciliation) treat them like any
// historical log. inventoryDebited is forced false — retro flows can't know
// what stock was consumed at the historical time, so cabinet inventory is
// not adjusted. Written via writeBatch for atomicity + a single round-trip.
//
// Caller is responsible for generating slot IDs (via buildSlotId) and
// deciding taken vs skipped per slot. retroactive=true is stamped on every
// row so consumers can render "Logged retroactively" hints.
export async function logRetroactiveDoses(
  hId: string,
  tId: string,
  args: {
    rId: string
    patientId: string
    cabinetItemId: string
    doseAmount: number
    doseUnit: string
    createdBy: string
    slots: Array<{
      slotId: string
      scheduledDate: string  // YYYY-MM-DD
      scheduledTime: string  // HH:MM
      status: 'taken' | 'skipped'
    }>
  },
): Promise<void> {
  if (args.slots.length === 0) return
  const { db, doc, writeBatch, serverTimestamp, Timestamp } = await getFirestoreContext()
  const batch = writeBatch(db)
  for (const s of args.slots) {
    const ref = doc(db, dosePath(hId, tId, s.slotId))
    // IST-anchored scheduledAt so the historical instant is unambiguous
    // regardless of the writer's wall clock TZ. Matches logDose's pattern.
    const scheduledAt = Timestamp.fromDate(
      new Date(`${s.scheduledDate}T${s.scheduledTime}:00+05:30`),
    )
    batch.set(ref, {
      slotId: s.slotId,
      tId,
      rId: args.rId,
      hId,
      patientId: args.patientId,
      scheduledAt,
      scheduledDate: s.scheduledDate,
      scheduledTime: s.scheduledTime,
      status: s.status,
      // takenAt is the "when we marked it" timestamp, distinct from
      // scheduledAt (the dose's intended instant). For retro logs marked
      // 'taken', takenAt is now; 'skipped' carries null.
      takenAt: s.status === 'taken' ? serverTimestamp() : null,
      // AK-154 — skipReason is now a structured id; the retro-catch-up
      // explanation lives in skipReasonText under the 'other' bucket.
      skipReason: s.status === 'skipped' ? ('other' as SkipReasonId) : null,
      skipReasonText:
        s.status === 'skipped'
          ? 'Not logged at time of treatment creation'
          : null,
      lateNote: null,
      doseAmount: args.doseAmount,
      doseUnit: args.doseUnit,
      cabinetItemId: args.cabinetItemId,
      inventoryDebited: false,
      retroactive: true,
      createdBy: args.createdBy,
      createdAt: serverTimestamp(),
    })
  }
  await batch.commit()
}

// AK-123 — Append-only audit entry written when the admin clicks "I
// understand, proceed anyway" on the overlapping-treatment soft-warn modal.
// Lives at households/{hId}/treatments/{tId}/conflictAcknowledgements/{ackId}
// with a Firestore-generated id. Rules enforce admin-only create + self-uid
// match, and forbid update/delete so the audit trail is immutable.
export async function recordConflictAcknowledgement(
  hId: string,
  tId: string,
  args: {
    conflictingTreatmentId: string
    conflictType: 'overlap'
    acknowledgedByUid: string
    acknowledgedByName: string
  },
): Promise<void> {
  const { db, collection, addDoc, serverTimestamp } = await getFirestoreContext()
  await addDoc(
    collection(db, `households/${hId}/treatments/${tId}/conflictAcknowledgements`),
    {
      acknowledgedAt: serverTimestamp(),
      ...args,
    },
  )
}

// AK-39 sub-task 3 — Append-only audit entry written when an admin overrides
// a hard-block drug-interaction warning at step 2 → step 3 of the wizard.
// Lives at households/{hId}/treatments/{tId}/interactionAcknowledgements/{ackId}
// with a Firestore-generated id. Same immutability contract as the AK-123
// conflictAcknowledgements row — rules enforce admin-only create, self-uid
// match, and forbid update/delete.
//
// Called from handleSave after the treatment + regimen writes succeed, so
// the ack row addresses a real treatment doc. Failure is swallowed: an
// audit-row write that fails must not roll back the treatment.
export async function recordInteractionAcknowledgement(
  hId: string,
  tId: string,
  payload: {
    conflictingCabinetItemId: string
    conflictingMedicineName: string
    interactionSummary: string
    justification: string
    acknowledgedByUid: string
    acknowledgedByName: string
  },
): Promise<void> {
  const { db, collection, addDoc, serverTimestamp } = await getFirestoreContext()
  await addDoc(
    collection(db, `households/${hId}/treatments/${tId}/interactionAcknowledgements`),
    {
      acknowledgedAt: serverTimestamp(),
      ...payload,
    },
  )
}

export async function loadAllActiveRegimens(
  hId: string,
): Promise<{ treatments: Treatment[]; regimensByTreatment: Record<string, Regimen[]> }> {
  const { db, collection, query, where, getDocs } = await getFirestoreContext()
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
  const { db, doc, setDoc, serverTimestamp } = await getFirestoreContext()
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

// Returns the most recent consent doc from consentLog/{uid}/versions so
// App.tsx can decide whether to gate the user behind ConsentScreen.
// Null when the user has never consented (first sign-in) or the
// subcollection is unreadable (offline/permissions).
export async function getConsentRecord(uid: string): Promise<ConsentRecord | null> {
  const { db, collection, query, orderBy, limit, getDocs } = await getFirestoreContext()
  const q = query(
    collection(db, consentVersionPath(uid)),
    orderBy('consentedAt', 'desc'),
    limit(1),
  )
  const snap = await getDocs(q)
  if (snap.empty) return null
  return snap.docs[0].data() as ConsentRecord
}

// Append-only consent write. Each tap of "I agree" produces a new doc
// under consentLog/{uid}/versions with an auto-generated id; rules block
// update/delete so prior consents stay intact as the DPDP audit trail.
// A policy bump simply lands as a newer version doc; getConsentRecord
// returns the latest by consentedAt desc.
export async function recordConsent(uid: string, platform: string): Promise<void> {
  const { db, collection, addDoc, serverTimestamp } = await getFirestoreContext()
  const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || 'dev'
  await addDoc(collection(db, consentVersionPath(uid)), {
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
  const { db, doc, setDoc } = await getFirestoreContext()
  await setDoc(doc(db, userPath(uid)), prefs, { merge: true })
}

// ── Addresses (AK-163) ─────────────────────────────────────────
//
// Admin-managed delivery address book. Mirrors the cabinet-items CRUD shape:
// client-generated id, server timestamps, soft-delete via disposedAt.
// placeId / latitude / longitude / formattedAddress are intentionally
// immutable post-create — to change the underlying place the user picks the
// address from scratch via the search flow. The narrow updateAddress
// whitelist enforces that contract.

export async function addAddress(
  hId: string,
  data: {
    label: string
    recipientName: string
    recipientPhone: string
    houseNumber: string
    apartmentName?: string | null
    area: string
    city: string
    state: string
    pincode: string
    country: string
    landmark?: string | null
    placeId: string
    latitude: number
    longitude: number
    formattedAddress: string
    isDefault: boolean
  },
): Promise<string> {
  const { db, doc, setDoc, serverTimestamp } = await getFirestoreContext()
  const addressId = crypto.randomUUID()
  await setDoc(doc(db, addressPath(hId, addressId)), {
    ...data,
    addressId,
    hId,
    disposedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return addressId
}

export async function updateAddress(
  hId: string,
  addressId: string,
  updates: {
    label?: string
    recipientName?: string
    recipientPhone?: string
    houseNumber?: string
    apartmentName?: string | null
    area?: string
    city?: string
    state?: string
    pincode?: string
    country?: string
    landmark?: string | null
  },
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  await updateDoc(doc(db, addressPath(hId, addressId)), {
    ...updates,
    updatedAt: serverTimestamp(),
  })
}

// Soft-delete an address. The doc is preserved so any future order-history
// view that references the addressId still resolves; subscribeAddresses /
// getAddresses filter disposed rows out of the UI.
export async function disposeAddress(
  hId: string,
  addressId: string,
): Promise<void> {
  const { db, doc, updateDoc, serverTimestamp } = await getFirestoreContext()
  await updateDoc(doc(db, addressPath(hId, addressId)), {
    disposedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

// Atomically promote an address to default: clear the previous default's
// isDefault flag, set the new one's, and update household.defaultAddressId
// so the household doc remains the source of truth. The denormalised
// per-address isDefault boolean is purely a convenience for the list view
// (avoids a separate household read).
export async function setDefaultAddress(
  hId: string,
  addressId: string,
): Promise<void> {
  const { db, doc, runTransaction, serverTimestamp } = await getFirestoreContext()
  await runTransaction(db, async tx => {
    const householdRef = doc(db, householdPath(hId))
    const householdSnap = await tx.get(householdRef)
    const previousDefaultId =
      (householdSnap.data()?.defaultAddressId as string | null | undefined) ?? null

    if (previousDefaultId && previousDefaultId !== addressId) {
      tx.update(doc(db, addressPath(hId, previousDefaultId)), {
        isDefault: false,
        updatedAt: serverTimestamp(),
      })
    }

    tx.update(doc(db, addressPath(hId, addressId)), {
      isDefault: true,
      updatedAt: serverTimestamp(),
    })

    tx.update(householdRef, { defaultAddressId: addressId })
  })
}

export function subscribeAddresses(
  hId: string,
  onData: (addresses: Address[]) => void,
  onError?: (error: Error) => void,
): () => void {
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, onSnapshot }) => {
      if (cancelled) return
      realUnsub = onSnapshot(
        collection(db, addressesCollectionPath(hId)),
        snap => {
          const rows = snap.docs
            .map(d => d.data() as Address)
            .filter(a => !a.disposedAt)
          onData(rows)
        },
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeAddresses: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

export async function getAddresses(hId: string): Promise<Address[]> {
  const { db, collection, getDocs } = await getFirestoreContext()
  const snap = await getDocs(collection(db, addressesCollectionPath(hId)))
  return snap.docs
    .map(d => d.data() as Address)
    .filter(a => !a.disposedAt)
}

// ── AK-195 — real-time subscriptions for the Reimagined context ───────────────
// Additive only: these mirror the existing subscribe* pattern (deferred
// Firestore init + cancellable unsubscribe) and back the parallel
// ReimaginedCtx. The existing app's data flow does not use them.

export function subscribeHouseholdMembers(
  hId: string,
  onData: (members: HouseholdMember[]) => void,
  onError?: (error: Error) => void,
): () => void {
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, onSnapshot }) => {
      if (cancelled) return
      realUnsub = onSnapshot(
        collection(db, membersCollectionPath(hId)),
        snap => onData(snap.docs.map(d => d.data() as HouseholdMember)),
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeHouseholdMembers: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

export function subscribeRegimens(
  hId: string,
  tId: string,
  onData: (regimens: Regimen[]) => void,
  onError?: (error: Error) => void,
): () => void {
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, onSnapshot }) => {
      if (cancelled) return
      realUnsub = onSnapshot(
        collection(db, regimensCollectionPath(hId, tId)),
        snap => onData(snap.docs.map(d => d.data() as Regimen)),
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeRegimens: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

// Today's dose logs for one treatment. Filters on scheduledDate (single-field
// index, no composite needed) so the listener only carries the current day.
export function subscribeTodayLogs(
  hId: string,
  tId: string,
  today: string,
  onData: (logs: DoseLog[]) => void,
  onError?: (error: Error) => void,
): () => void {
  let realUnsub: (() => void) | undefined
  let cancelled = false
  getFirestoreContext()
    .then(({ db, collection, query, where, onSnapshot }) => {
      if (cancelled) return
      realUnsub = onSnapshot(
        query(
          collection(db, dosesCollectionPath(hId, tId)),
          where('scheduledDate', '==', today),
        ),
        snap => onData(snap.docs.map(d => d.data() as DoseLog)),
        err => onError?.(err),
      )
    })
    .catch(err => {
      console.warn('subscribeTodayLogs: deferred Firestore init failed', err)
      onError?.(err as Error)
    })
  return () => { cancelled = true; realUnsub?.() }
}

