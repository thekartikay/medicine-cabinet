import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getMessaging } from 'firebase-admin/messaging'
import { randomUUID } from 'node:crypto'

initializeApp()
setGlobalOptions({ region: 'asia-south1', maxInstances: 10 })

const db = getFirestore()
const auth = getAuth()
const messaging = getMessaging()

// ─── createHousehold ─────────────────────────────────────────────────────────
// Replaces the client-side createHousehold flow, which is no longer permitted
// by the Firestore Security Rules: a user cannot stamp `householdId` on their
// own users/{uid} doc and cannot self-assign the 'admin' custom claim.
//
// Steps (all under Admin SDK, bypassing rules):
//   1. Create households/{hId}
//   2. Create households/{hId}/members/{uid} with role 'admin'
//   3. Set custom auth claims { hId, role: 'admin' } so subsequent reads pass
//   4. Stamp householdId on users/{uid}
//
// The client must call user.getIdToken(true) after this resolves so the
// new claims appear in the token before any household-scoped reads.
// ─── joinHousehold ───────────────────────────────────────────────────────────
// Adds the calling user as a 'member' of the household whose 6-digit join code
// matches what they typed. The join code is a deterministic hash of the hId
// computed identically on client and server, so the two sides always agree.
//
// Steps (Admin SDK, bypasses Firestore Security Rules):
//   1. Reject if the caller is already in any household
//   2. Iterate households/* and find the one whose hId hashes to this code
//   3. Atomic write: members/{uid} (role:'member', languagePref:'en'),
//      households/{hId}.memberUids, users/{uid}.householdId
//   4. Set custom claims { hId, role:'member' }
//
// The client must call user.getIdToken(true) after this resolves so the new
// claims appear in the token before any household-scoped reads.
//
// TODO(MC-perf): scan-all-households is fine at MVP scale; switch to a
// joinCodes/{code} -> hId index doc when we exceed ~1k households so each
// joinHousehold call becomes O(1).
// Mirrors the client's computeJoinCode in src/screens/InviteMember.tsx
// byte-for-byte. The first 6 digits of the base64 of the hId, left-padded
// with zeros so the code is always exactly 6 chars.
function computeJoinCode(hId: string): string {
  const b64 = Buffer.from(hId).toString('base64')
  const digits = b64.replace(/[^0-9]/g, '')
  return digits.slice(0, 6).padStart(6, '0')
}

export const joinHousehold = onCall(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required to join a household.')
    }
    const uid = request.auth.uid

    const raw = (request.data ?? {}) as { joinCode?: unknown }
    const joinCode =
      typeof raw.joinCode === 'string' ? raw.joinCode.trim() : ''
    if (!/^\d{6}$/.test(joinCode)) {
      throw new HttpsError('invalid-argument', 'joinCode must be a 6-digit string.')
    }

    // 1. Reject if the caller already belongs to a household.
    const userRecord = await auth.getUser(uid)
    const existingClaims = userRecord.customClaims ?? {}
    if (existingClaims.hId) {
      throw new HttpsError(
        'already-exists',
        'You already belong to a household. Leave it before joining another.',
      )
    }

    // 2. Find the household whose hId hashes to this code.
    const allHouseholds = await db.collection('households').get()
    let matchedHId: string | null = null
    let matchedName: string | null = null
    for (const docSnap of allHouseholds.docs) {
      if (computeJoinCode(docSnap.id) === joinCode) {
        matchedHId = docSnap.id
        matchedName = (docSnap.data().name as string | undefined) ?? 'Household'
        break
      }
    }
    if (!matchedHId) {
      throw new HttpsError('not-found', 'No household with that code.')
    }

    const displayName = userRecord.displayName ?? null

    // 3. Atomic write.
    await db.runTransaction(async (tx) => {
      const memberRef = db.doc(`households/${matchedHId}/members/${uid}`)
      const memberSnap = await tx.get(memberRef)
      if (memberSnap.exists) {
        throw new HttpsError('already-exists', 'You are already a member of this household.')
      }

      tx.set(memberRef, {
        uid,
        hId: matchedHId,
        role: 'member',
        displayName,
        languagePref: 'en',
        joinedAt: FieldValue.serverTimestamp(),
      })

      tx.update(db.doc(`households/${matchedHId}`), {
        memberUids: FieldValue.arrayUnion(uid),
      })

      tx.set(
        db.doc(`users/${uid}`),
        { householdId: matchedHId },
        { merge: true },
      )
    })

    // 4. Set custom claims so the security rules treat this user as a member.
    await auth.setCustomUserClaims(uid, {
      ...existingClaims,
      hId: matchedHId,
      role: 'member',
    })

    return { hId: matchedHId, householdName: matchedName }
  },
)

export const createHousehold = onCall(
  { enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required to create a household.')
    }
    const uid = request.auth.uid

    const raw = (request.data ?? {}) as { householdName?: unknown }
    const householdName =
      typeof raw.householdName === 'string' ? raw.householdName.trim() : ''
    if (!householdName) {
      throw new HttpsError('invalid-argument', 'householdName must be a non-empty string.')
    }
    if (householdName.length > 60) {
      throw new HttpsError('invalid-argument', 'householdName must be 60 characters or fewer.')
    }

    const hId = randomUUID()
    const userRecord = await auth.getUser(uid)
    const displayName = userRecord.displayName ?? null

    // Atomic Firestore write of household + member + user.householdId.
    await db.runTransaction(async (tx) => {
      tx.set(db.doc(`households/${hId}`), {
        hId,
        name: householdName,
        primaryAdminId: uid,
        adminIds: [uid],
        memberUids: [uid],
        createdAt: FieldValue.serverTimestamp(),
        lastAuditAt: null,
      })

      tx.set(db.doc(`households/${hId}/members/${uid}`), {
        uid,
        hId,
        role: 'admin',
        displayName,
        joinedAt: FieldValue.serverTimestamp(),
      })

      tx.set(
        db.doc(`users/${uid}`),
        { householdId: hId },
        { merge: true },
      )
    })

    // Custom claims drive Firestore Security Rules. Preserve any pre-existing
    // claims the user may have so we don't accidentally clobber e.g. a phone-
    // verified flag set elsewhere.
    const existingClaims = userRecord.customClaims ?? {}
    await auth.setCustomUserClaims(uid, {
      ...existingClaims,
      hId,
      role: 'admin',
    })

    return { hId, name: householdName }
  },
)

// ─── scheduleDoseNotifications (MC-006) ─────────────────────────────────────
// Every 15 minutes (anchored to IST), send an FCM push for any active dose
// slot whose scheduled time falls within the next 15 minutes and which the
// patient has not already logged.
//
// Per CLAUDE.md schema:
//   • Treatment.memberId is the patient (no `patientId` field on the doc)
//   • Regimen.displayName is the human-facing medicine label
//   • Dose log slot id is `{tId}-{rId}-{patientId}-{YYYY-MM-DD}-{HHmm}` —
//     identical to buildSlotId() in src/lib/paths.ts so we can detect
//     already-logged slots without re-deriving the format.
//
// Slot times are stored as "HH:MM" in IST. We construct the absolute
// timestamp by combining today's IST date with the slot's HH:MM and the
// +05:30 offset, so the comparison to `now` works regardless of the
// container's timezone.

// Returns IST today's date as YYYY-MM-DD using Swedish locale (ISO order).
function todayISTDateString(now: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

// Returns IST day-of-week 0..6 (Sun..Sat) for a given absolute Date.
function dayOfWeekIST(now: Date): number {
  const w = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', weekday: 'short',
  }).format(now)
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(w)
}

// Resolves "today (IST) at HH:MM IST" to an absolute Date.
function istSlotInstant(dateStr: string, slotHHMM: string): Date {
  return new Date(`${dateStr}T${slotHHMM}:00+05:30`)
}

// Friendly "After food" / "Before food" / "With food" suffix for the body.
function foodLabel(timing: unknown): string {
  if (timing === 'after')  return 'After food'
  if (timing === 'before') return 'Before food'
  if (timing === 'with')   return 'With food'
  return 'Any time'
}

export const scheduleDoseNotifications = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Asia/Kolkata',
    region: 'asia-south1',
    minInstances: 1,
  },
  async () => {
    const now = new Date()
    const windowStart = now
    const windowEnd = new Date(now.getTime() + 15 * 60 * 1000)
    const todayIST = todayISTDateString(now)
    const dowIST = dayOfWeekIST(now)

    // Cache user docs so we don't re-fetch the same patient repeatedly when
    // they have multiple regimens firing in the same window.
    const userCache = new Map<string, FirebaseFirestore.DocumentData | null>()
    async function getUser(uid: string) {
      if (userCache.has(uid)) return userCache.get(uid) ?? null
      const snap = await db.doc(`users/${uid}`).get()
      const data = snap.exists ? snap.data() ?? null : null
      userCache.set(uid, data)
      return data
    }

    const households = await db.collection('households').get()

    for (const hDoc of households.docs) {
      const hId = hDoc.id

      const treatments = await db
        .collection(`households/${hId}/treatments`)
        .where('status', '==', 'active')
        .get()

      for (const tDoc of treatments.docs) {
        const tId = tDoc.id
        const treatment = tDoc.data()
        const patientId = treatment.memberId as string | undefined
        if (!patientId) continue

        const regimens = await db
          .collection(`households/${hId}/treatments/${tId}/regimens`)
          .get()

        for (const rDoc of regimens.docs) {
          const rId = rDoc.id
          const regimen = rDoc.data()

          // Skip regimens that aren't active today or aren't time-driven.
          const scheduleType = regimen.scheduleType as string | undefined
          if (scheduleType === 'as-needed') continue
          if (regimen.startDate && regimen.startDate > todayIST) continue
          if (regimen.endDate && regimen.endDate < todayIST) continue
          if (scheduleType === 'specific-days') {
            const days = regimen.scheduleDays as number[] | undefined
            if (!days?.includes(dowIST)) continue
          }

          const slots = (regimen.slots ?? []) as Array<{ time: string; foodTiming?: string }>
          for (const slot of slots) {
            if (typeof slot.time !== 'string' || !/^\d{2}:\d{2}$/.test(slot.time)) continue
            const slotInstant = istSlotInstant(todayIST, slot.time)
            if (slotInstant < windowStart || slotInstant > windowEnd) continue

            const hhmm = slot.time.replace(':', '')
            const slotId = `${tId}-${rId}-${patientId}-${todayIST}-${hhmm}`

            // Skip if already logged.
            const logSnap = await db
              .doc(`households/${hId}/treatments/${tId}/logs/${slotId}`)
              .get()
            if (logSnap.exists) continue

            const userData = await getUser(patientId)
            if (!userData?.fcmToken) continue
            if (userData.pushNotificationsEnabled === false) continue

            const medicineName = (regimen.displayName as string | undefined)
              ?? 'your medicine'
            const doseAmount = regimen.doseAmount ?? ''
            const doseUnit   = regimen.doseUnit ?? ''

            try {
              await messaging.send({
                token: userData.fcmToken,
                notification: {
                  title: `Time for ${medicineName}`,
                  body: `${slot.time} · ${doseAmount} ${doseUnit} · ${foodLabel(slot.foodTiming)}`,
                },
                data: {
                  slotId,
                  treatmentId: tId,
                  householdId: hId,
                  type: 'dose_reminder',
                },
                android: { priority: 'high' },
                apns: {
                  payload: {
                    aps: { sound: 'default', badge: 1 },
                  },
                },
              })
            } catch (err: unknown) {
              // Stale token — drop it so the next cron pass doesn't retry.
              const code = (err as { code?: string })?.code
              if (code === 'messaging/registration-token-not-registered') {
                await db.doc(`users/${patientId}`).update({
                  fcmToken: FieldValue.delete(),
                })
                userCache.delete(patientId)
              }
              // Otherwise swallow — one bad send shouldn't abort the cron.
            }
          }
        }
      }
    }
  },
)

// ─── testSendNotification (MC-006, dev/test helper) ─────────────────────────
// HTTPS callable that sends one FCM notification to the calling user, using
// the fcmToken stored on their users/{uid} doc. Lets us verify SW registration
// and FCM delivery end-to-end without waiting for the cron to fire.
//
// Not gated by environment because Cloud Functions v2 deploys a single binary
// per project; the only abuse vector is "send a push to yourself", which is
// harmless. Refuse if no token is registered.
export const testSendNotification = onCall(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    let uid: string | undefined = request.auth?.uid

    // Emulator-only dev fallback: the local Functions emulator sets
    // FUNCTIONS_EMULATOR=true at runtime. When invoked from the dev "Test
    // FCM" button without an auth context, accept the uid in the data
    // payload. The deployed production function never sees this branch,
    // so it cannot be abused by an unauthenticated caller in prod.
    if (!uid && process.env.FUNCTIONS_EMULATOR === 'true') {
      const raw = (request.data ?? {}) as { uid?: unknown }
      if (typeof raw.uid === 'string' && raw.uid.length > 0) {
        uid = raw.uid
      }
    }

    if (!uid) {
      throw new HttpsError('unauthenticated', 'Sign in required.')
    }

    const userSnap = await db.doc(`users/${uid}`).get()
    const fcmToken = userSnap.data()?.fcmToken as string | undefined
    if (!fcmToken) {
      throw new HttpsError(
        'failed-precondition',
        'No FCM token registered for this user. Grant notification permission first.',
      )
    }

    try {
      await messaging.send({
        token: fcmToken,
        notification: {
          title: 'MediCab test notification',
          body: 'If you can see this, push delivery is working.',
        },
        data: { type: 'test' },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      })
      return { ok: true }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'messaging/registration-token-not-registered') {
        await db.doc(`users/${uid}`).update({ fcmToken: FieldValue.delete() })
        throw new HttpsError(
          'failed-precondition',
          'Stored FCM token is no longer valid; please grant permission again.',
        )
      }
      throw new HttpsError('internal', 'FCM send failed.')
    }
  },
)

// ─── sendDoseReminder (MC-008) ───────────────────────────────────────────────
// Admin-triggered FCM push to a specific patient: "please take your X". Used
// by the Dashboard "Remind {name}" button that surfaces when a patient's dose
// is past its grace window.
//
// Authorization: caller must be in households/{hId}.adminIds. Refuses with
// failed-precondition if the patient has no FCM token registered or has push
// notifications disabled — the client surfaces these as a distinct toast.
export const sendDoseReminder = onCall(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }

    const raw = (request.data ?? {}) as {
      patientId?: unknown
      medicineName?: unknown
      slotTime?: unknown
      hId?: unknown
      slotId?: unknown
    }
    const patientId    = typeof raw.patientId    === 'string' ? raw.patientId    : ''
    const medicineName = typeof raw.medicineName === 'string' ? raw.medicineName : ''
    const slotTime     = typeof raw.slotTime     === 'string' ? raw.slotTime     : ''
    const hId          = typeof raw.hId          === 'string' ? raw.hId          : ''
    const slotId       = typeof raw.slotId       === 'string' ? raw.slotId       : ''
    if (!patientId || !medicineName || !slotTime || !hId || !slotId) {
      throw new HttpsError(
        'invalid-argument',
        'patientId, medicineName, slotTime, slotId, and hId are required.',
      )
    }

    const hSnap = await db.doc(`households/${hId}`).get()
    const household = hSnap.data() as { adminIds?: string[] } | undefined
    if (!household?.adminIds?.includes(request.auth.uid)) {
      throw new HttpsError('permission-denied', 'Admins only')
    }

    const patientSnap = await db.doc(`users/${patientId}`).get()
    const patientData = patientSnap.data()
    const fcmToken = patientData?.fcmToken as string | undefined

    if (!fcmToken) {
      throw new HttpsError(
        'failed-precondition',
        'Member has no notification token registered',
      )
    }
    if (patientData?.pushNotificationsEnabled === false) {
      throw new HttpsError(
        'failed-precondition',
        'Member has disabled push notifications',
      )
    }

    try {
      await messaging.send({
        token: fcmToken,
        notification: {
          title: 'Reminder from your caregiver',
          body: `Please take your ${medicineName} — scheduled for ${slotTime}`,
        },
        data: {
          type: 'caregiver_reminder',
          householdId: hId,
        },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      })
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'messaging/registration-token-not-registered') {
        await db.doc(`users/${patientId}`).update({ fcmToken: FieldValue.delete() })
        throw new HttpsError(
          'failed-precondition',
          "Member's notification token is no longer valid",
        )
      }
      throw new HttpsError('internal', 'FCM send failed.')
    }

    // After a successful FCM send, write a notification doc so the reminder
    // appears in the in-app panel for the recipient (member) and the sender
    // (admin already saw it — readBy seeded with their uid). Deterministic id
    // dedupes accidental double-clicks.
    const notifId = `reminder_${slotId}`
    try {
      await db.doc(`households/${hId}/notifications/${notifId}`).create({
        notifId,
        type: 'caregiver_reminder',
        message: `Caregiver reminder: take your ${medicineName} at ${slotTime}`,
        createdAt: FieldValue.serverTimestamp(),
        readBy: [request.auth.uid],
        relatedMemberId: patientId,
        relatedMedicineId: null,
      })
    } catch (err: unknown) {
      const code = (err as { code?: number | string })?.code
      // ALREADY_EXISTS — admin double-clicked. Best-effort; FCM already fired.
      if (code !== 6 && code !== 'already-exists') {
        // Other errors: swallow so the FCM success isn't masked by the
        // notification panel write.
      }
    }

    return { ok: true }
  },
)

// ─── markMissedDoses (MC-007) ────────────────────────────────────────────────
// Every 30 minutes (anchored to IST), mark any dose slot whose scheduled time
// is more than 30 minutes in the past and which has no log yet as 'missed',
// then notify all household admins via FCM.
//
// Slot-id format and regimen filtering mirror scheduleDoseNotifications
// (MC-006). The write uses logRef.create() — atomic existence check, fails
// with ALREADY_EXISTS if the user (or another cron pass) already logged the
// slot, which we swallow. This avoids the get-then-set race that would let
// the cron clobber a 'taken' log written between the two calls.
//
// We inspect both today's and yesterday's IST date because near IST midnight
// the 30-minute cutoff falls in yesterday's late-night slots. e.g. at 00:15
// IST the cutoff is 23:45 yesterday — a 23:30 yesterday slot is past cutoff
// and would otherwise never be evaluated.

function dayOfWeekForISTDate(dateStr: string): number {
  // Anchor at noon IST → unambiguous calendar day in any runtime TZ.
  return new Date(`${dateStr}T12:00:00+05:30`).getUTCDay()
}

function previousISTDateString(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`)
  d.setUTCDate(d.getUTCDate() - 1)
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

export const markMissedDoses = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'Asia/Kolkata',
    region: 'asia-south1',
    minInstances: 0,
  },
  async () => {
    const now = new Date()
    const cutoff = new Date(now.getTime() - 30 * 60 * 1000)
    const todayIST = todayISTDateString(now)
    const yesterdayIST = previousISTDateString(todayIST)
    const dates = [yesterdayIST, todayIST]

    const userCache = new Map<string, FirebaseFirestore.DocumentData | null>()
    async function getUser(uid: string) {
      if (userCache.has(uid)) return userCache.get(uid) ?? null
      const snap = await db.doc(`users/${uid}`).get()
      const data = snap.exists ? snap.data() ?? null : null
      userCache.set(uid, data)
      return data
    }

    const households = await db.collection('households').get()

    for (const hDoc of households.docs) {
      const hId = hDoc.id
      const household = hDoc.data() as { adminIds?: string[] }
      const adminIds = household.adminIds ?? []

      const treatments = await db
        .collection(`households/${hId}/treatments`)
        .where('status', '==', 'active')
        .get()

      for (const tDoc of treatments.docs) {
        const tId = tDoc.id
        const treatment = tDoc.data()
        const patientId = treatment.memberId as string | undefined
        if (!patientId) continue

        const regimens = await db
          .collection(`households/${hId}/treatments/${tId}/regimens`)
          .get()

        for (const rDoc of regimens.docs) {
          const rId = rDoc.id
          const regimen = rDoc.data()

          const scheduleType = regimen.scheduleType as string | undefined
          if (scheduleType === 'as-needed') continue

          const slots = (regimen.slots ?? []) as Array<{ time: string; foodTiming?: string }>
          if (slots.length === 0) continue

          for (const dateStr of dates) {
            if (regimen.startDate && regimen.startDate > dateStr) continue
            if (regimen.endDate && regimen.endDate < dateStr) continue
            if (scheduleType === 'specific-days') {
              const days = regimen.scheduleDays as number[] | undefined
              if (!days?.includes(dayOfWeekForISTDate(dateStr))) continue
            }

            for (const slot of slots) {
              if (typeof slot.time !== 'string' || !/^\d{2}:\d{2}$/.test(slot.time)) continue
              const slotInstant = istSlotInstant(dateStr, slot.time)
              // Only mark slots that have already fired AND are past the
              // 30-minute grace window.
              if (slotInstant > now) continue
              if (slotInstant >= cutoff) continue

              const hhmm = slot.time.replace(':', '')
              const slotId = `${tId}-${rId}-${patientId}-${dateStr}-${hhmm}`
              const logRef = db.doc(`households/${hId}/treatments/${tId}/logs/${slotId}`)

              try {
                await logRef.create({
                  slotId,
                  tId,
                  rId,
                  hId,
                  patientId,
                  scheduledAt: Timestamp.fromDate(slotInstant),
                  scheduledDate: dateStr,
                  scheduledTime: slot.time,
                  status: 'missed',
                  takenAt: null,
                  skipReason: null,
                  lateNote: null,
                  doseAmount: regimen.doseAmount ?? 0,
                  doseUnit: regimen.doseUnit ?? '',
                  cabinetItemId: regimen.cabinetItemId ?? '',
                  inventoryDebited: false,
                  createdBy: 'system',
                  createdAt: FieldValue.serverTimestamp(),
                })
              } catch (err: unknown) {
                const code = (err as { code?: number | string })?.code
                // 6 = ALREADY_EXISTS (gRPC). Slot was logged by the user (or a
                // prior cron pass) between our filter and the create — skip.
                if (code === 6 || code === 'already-exists') continue
                // Other errors: surface so they aren't silently dropped.
                throw err
              }

              // Notify every admin in the household. Patient name is fetched
              // once per slot; admins are cached across the whole pass.
              const medicineName = (regimen.displayName as string | undefined) ?? 'their medicine'
              const patient = await getUser(patientId)
              const patientName = (patient?.displayName as string | undefined) ?? 'A family member'

              // Write a notification for the in-app alerts panel. Deterministic
              // id (`missed_${slotId}`) prevents dupes if the cron ever loops.
              // Best-effort — a failed notification write must not abort the
              // admin FCM fan-out below.
              const notifId = `missed_${slotId}`
              try {
                await db.doc(`households/${hId}/notifications/${notifId}`).create({
                  notifId,
                  type: 'missed_dose',
                  message: `${patientName} missed their ${medicineName} at ${slot.time}`,
                  createdAt: FieldValue.serverTimestamp(),
                  readBy: [],
                  relatedMemberId: patientId,
                  relatedMedicineId: (regimen.cabinetItemId as string | undefined) ?? null,
                })
              } catch (err: unknown) {
                const code = (err as { code?: number | string })?.code
                // 6 = ALREADY_EXISTS — fine, prior pass already wrote it.
                if (code !== 6 && code !== 'already-exists') {
                  // Other errors: swallow. Admin still sees the missed status
                  // in the dashboard via the dose log itself.
                }
              }

              for (const adminId of adminIds) {
                const adminData = await getUser(adminId)
                if (!adminData?.fcmToken) continue
                if (adminData.pushNotificationsEnabled === false) continue

                try {
                  await messaging.send({
                    token: adminData.fcmToken as string,
                    notification: {
                      title: `Missed dose — ${patientName}`,
                      body: `${patientName} missed their ${slot.time} ${medicineName}`,
                    },
                    data: {
                      type: 'missed_dose',
                      householdId: hId,
                      treatmentId: tId,
                      slotId,
                      patientId,
                    },
                    android: { priority: 'high' },
                    apns: {
                      payload: { aps: { sound: 'default', badge: 1 } },
                    },
                  })
                } catch (err: unknown) {
                  const code = (err as { code?: string })?.code
                  if (code === 'messaging/registration-token-not-registered') {
                    await db.doc(`users/${adminId}`).update({
                      fcmToken: FieldValue.delete(),
                    })
                    userCache.delete(adminId)
                  }
                  // Otherwise swallow — one bad admin shouldn't abort the cron.
                }
              }
            }
          }
        }
      }
    }
  },
)

// ─── onRestockRequested (MC-009) ─────────────────────────────────────────────
// Firestore trigger: when a member writes a new restockRequests doc, post a
// notification for the household admins and FCM-fan-out to their devices.
// Trigger runs with Admin-SDK auth, so notifications/{notifId} create rule
// (admin-only) doesn't block this write.
export const onRestockRequested = onDocumentCreated(
  {
    document: 'households/{hId}/restockRequests/{requestId}',
    region: 'asia-south1',
  },
  async (event) => {
    const hId = event.params.hId
    const requestId = event.params.requestId
    const request = event.data?.data()
    if (!request) return

    const hSnap = await db.doc(`households/${hId}`).get()
    const household = hSnap.data() as { adminIds?: string[] } | undefined
    if (!household) return

    const memberSnap = await db
      .doc(`households/${hId}/members/${request.requestedBy}`)
      .get()
    const memberName = (memberSnap.data()?.displayName as string | undefined) ?? 'A member'
    const medicineName = (request.medicineName as string | undefined) ?? 'a medicine'

    // Notification panel doc. create() with ALREADY_EXISTS swallow dedupes if
    // the trigger ever delivers more than once (Firestore semantics: at-least-
    // once). Deterministic id = restock_${requestId}.
    const notifId = `restock_${requestId}`
    try {
      await db.doc(`households/${hId}/notifications/${notifId}`).create({
        notifId,
        type: 'restock_request',
        message: `${memberName} requested restock of ${medicineName}`,
        createdAt: FieldValue.serverTimestamp(),
        readBy: [],
        relatedMemberId: request.requestedBy,
        relatedMedicineId: request.cabinetItemId ?? null,
      })
    } catch (err: unknown) {
      const code = (err as { code?: number | string })?.code
      if (code !== 6 && code !== 'already-exists') {
        // Best-effort — don't fail the trigger if the notif write blows up.
      }
    }

    // FCM fan-out to admins.
    const adminIds = household.adminIds ?? []
    for (const adminId of adminIds) {
      const adminSnap = await db.doc(`users/${adminId}`).get()
      const adminData = adminSnap.data()
      if (!adminData?.fcmToken) continue
      if (adminData.pushNotificationsEnabled === false) continue
      try {
        await messaging.send({
          token: adminData.fcmToken as string,
          notification: {
            title: 'Restock requested',
            body: `${memberName} needs more ${medicineName}`,
          },
          data: {
            type: 'restock_request',
            householdId: hId,
            requestId,
          },
          android: { priority: 'high' },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        })
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code
        if (code === 'messaging/registration-token-not-registered') {
          await db.doc(`users/${adminId}`).update({
            fcmToken: FieldValue.delete(),
          })
        }
        // Other errors: swallow.
      }
    }
  },
)

// ─── deleteTreatment (MC-010) ────────────────────────────────────────────────
// Hard-deletes a treatment plus all its regimens and dose logs. Routes
// through a Cloud Function because logs/{slotId}.delete is denied by rules
// for clients (logs are append-only at the client layer); the Admin SDK
// here bypasses rules. Used by Treatments.tsx for acute / prn treatments
// where preserving history isn't valuable enough to keep the document.
export const deleteTreatment = onCall(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required')
    }

    const raw = (request.data ?? {}) as { hId?: unknown; tId?: unknown }
    const hId = typeof raw.hId === 'string' ? raw.hId : ''
    const tId = typeof raw.tId === 'string' ? raw.tId : ''
    if (!hId || !tId) {
      throw new HttpsError('invalid-argument', 'hId and tId are required.')
    }

    const hSnap = await db.doc(`households/${hId}`).get()
    const household = hSnap.data() as { adminIds?: string[] } | undefined
    if (!household?.adminIds?.includes(request.auth.uid)) {
      throw new HttpsError('permission-denied', 'Admins only')
    }

    const [regimens, logs] = await Promise.all([
      db.collection(`households/${hId}/treatments/${tId}/regimens`).get(),
      db.collection(`households/${hId}/treatments/${tId}/logs`).get(),
    ])

    // Batches max out at 500 ops; chunk at 499 to leave room.
    const allDocs = [...regimens.docs, ...logs.docs]
    for (let i = 0; i < allDocs.length; i += 499) {
      const batch = db.batch()
      allDocs.slice(i, i + 499).forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
    await db.doc(`households/${hId}/treatments/${tId}`).delete()
    return { ok: true }
  },
)

// ─── MC-020 — maintainTodaySummary ───────────────────────────────────────────
// Keeps households/{hId}/todaySummary/{YYYY-MM-DD} accurate so the admin
// dashboard reads ONE document instead of fanning out to treatments + logs.
// Per CLAUDE.md rule 7, todaySummary is Cloud-Function-written only.
//
// Composition:
//   • Helper: buildTodaySummaryForHousehold(hId, date) — full rebuild.
//   • Trigger A: onLogWritten        — partial update for one slot + recount.
//   • Trigger B: onCabinetItemWritten — refresh stockAlerts only.
//   • Trigger C: rebuildTodaySummary  — daily 00:00 IST archive + rebuild.
//   • Trigger D: onTreatmentWritten   — rebuild today (status changes etc.).

interface TSSlot {
  treatmentId: string
  treatmentName: string
  regimenId: string
  medicineName: string
  scheduledTime: string
  doseAmount: number
  doseUnit: string
  foodTiming: string
  cabinetItemId: string
  status: 'taken' | 'late' | 'skipped' | 'missed' | 'pending'
  loggedAt: FirebaseFirestore.Timestamp | null
  skipReason: string | null
  lateNote: string | null
  adminOverride: boolean
  createdBy: string | null
}

interface TSStockAlert {
  cabinetItemId: string
  medicineName: string
  quantityOnHand: number
  daysSupply: number | null
  expiryDate: string | null
  daysUntilExpiry: number | null
}

interface TSMember {
  displayName: string
  totalSlots: number
  takenCount: number
  missedCount: number
  skippedCount: number
  lateCount: number
  pendingCount: number
  adherenceTodayPct: number
  slots: Record<string, TSSlot>
  stockAlerts: TSStockAlert[]
  auditNudgeText: string | null
}

// IST date string (YYYY-MM-DD) for an arbitrary instant.
function toISTDateString(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

function dayOfWeekForISTDateUTC(dateStr: string): number {
  // Already defined for MC-007 above, but re-deriving here so this block stays
  // self-contained; small helper, no real cost.
  return new Date(`${dateStr}T12:00:00+05:30`).getUTCDay()
}

function recountMember(member: TSMember): TSMember {
  let taken = 0, missed = 0, skipped = 0, late = 0, pending = 0
  for (const s of Object.values(member.slots)) {
    if      (s.status === 'taken')   taken++
    else if (s.status === 'late')    late++
    else if (s.status === 'skipped') skipped++
    else if (s.status === 'missed')  missed++
    else                             pending++
  }
  const total = taken + missed + skipped + late + pending
  // Adherence today = (taken + late) / (total - skipped). Skipped doses
  // legitimately exclude themselves from the denominator.
  const denom = total - skipped
  const pct = denom > 0 ? Math.round(((taken + late) / denom) * 100) : 0
  return {
    ...member,
    totalSlots: total,
    takenCount: taken,
    missedCount: missed,
    skippedCount: skipped,
    lateCount: late,
    pendingCount: pending,
    adherenceTodayPct: pct,
  }
}

// Build (or rebuild) todaySummary/{date} for one household. Single full write,
// idempotent. Used by the midnight cron, the treatment-write trigger, and as
// the materialization fallback inside the log trigger when the doc is absent.
async function buildTodaySummaryForHousehold(
  hId: string,
  date: string,
): Promise<void> {
  const summaryRef = db.doc(`households/${hId}/todaySummary/${date}`)
  const dowIST = dayOfWeekForISTDateUTC(date)

  const [treatmentsSnap, membersSnap, cabinetsSnap] = await Promise.all([
    db.collection(`households/${hId}/treatments`).where('status', '==', 'active').get(),
    db.collection(`households/${hId}/members`).get(),
    db.collection(`households/${hId}/cabinets`).get(),
  ])

  // Member roster — keyed by uid for lookup of displayName.
  const memberDisplayName = new Map<string, string>()
  for (const m of membersSnap.docs) {
    const data = m.data() as { displayName?: string | null }
    memberDisplayName.set(m.id, data.displayName?.trim() || 'Member')
  }

  // Cabinet items — flatten across all cabinets in this household. Used for
  // stockAlerts and for translating cabinetItemId → medicineName.
  const itemsByIId = new Map<string, FirebaseFirestore.DocumentData & { iId: string; cId: string }>()
  for (const cabinetDoc of cabinetsSnap.docs) {
    const itemsSnap = await cabinetDoc.ref.collection('items').get()
    for (const item of itemsSnap.docs) {
      itemsByIId.set(item.id, { ...(item.data()), iId: item.id, cId: cabinetDoc.id })
    }
  }

  // Per-member slot maps. We seed the member entries we touch via treatments.
  const memberMap: Record<string, TSMember> = {}
  function ensureMember(uid: string): TSMember {
    if (!memberMap[uid]) {
      memberMap[uid] = {
        displayName: memberDisplayName.get(uid) ?? 'Member',
        totalSlots: 0,
        takenCount: 0,
        missedCount: 0,
        skippedCount: 0,
        lateCount: 0,
        pendingCount: 0,
        adherenceTodayPct: 0,
        slots: {},
        stockAlerts: [],
        auditNudgeText: null,
      }
    }
    return memberMap[uid]
  }

  // Track per-member daily dose totals per cabinet item, so daysSupply can
  // be computed accurately when one item powers multiple regimens.
  const dailyAmountByMemberAndItem = new Map<string, Map<string, number>>()

  for (const tDoc of treatmentsSnap.docs) {
    const tId = tDoc.id
    const t = tDoc.data() as { name?: string; memberId?: string; status?: string }
    const patientId = t.memberId
    if (!patientId) continue

    const regimensSnap = await tDoc.ref.collection('regimens').get()
    for (const rDoc of regimensSnap.docs) {
      const rId = rDoc.id
      const r = rDoc.data() as {
        cabinetItemId?: string
        displayName?: string
        doseAmount?: number
        doseUnit?: string
        scheduleType?: string
        scheduleDays?: number[]
        slots?: Array<{ time: string; foodTiming?: string }>
        startDate?: string
        endDate?: string | null
      }
      const scheduleType = r.scheduleType
      if (scheduleType === 'as-needed') continue
      if (r.startDate && r.startDate > date) continue
      if (r.endDate && r.endDate < date) continue
      if (scheduleType === 'specific-days') {
        if (!r.scheduleDays?.includes(dowIST)) continue
      }

      const member = ensureMember(patientId)
      const slots = r.slots ?? []
      const slotsPerDay = slots.length
      const doseAmount = r.doseAmount ?? 0
      const cabinetItemId = r.cabinetItemId ?? ''

      // Track daily amount for daysSupply.
      if (cabinetItemId && doseAmount > 0 && slotsPerDay > 0) {
        let perItem = dailyAmountByMemberAndItem.get(patientId)
        if (!perItem) {
          perItem = new Map()
          dailyAmountByMemberAndItem.set(patientId, perItem)
        }
        perItem.set(
          cabinetItemId,
          (perItem.get(cabinetItemId) ?? 0) + slotsPerDay * doseAmount,
        )
      }

      for (const slot of slots) {
        if (typeof slot.time !== 'string' || !/^\d{2}:\d{2}$/.test(slot.time)) continue
        const hhmm = slot.time.replace(':', '')
        const slotId = `${tId}-${rId}-${patientId}-${date}-${hhmm}`
        member.slots[slotId] = {
          treatmentId: tId,
          treatmentName: t.name ?? 'Treatment',
          regimenId: rId,
          medicineName: r.displayName ?? 'Medicine',
          scheduledTime: slot.time,
          doseAmount,
          doseUnit: r.doseUnit ?? '',
          foodTiming: slot.foodTiming ?? 'after',
          cabinetItemId,
          status: 'pending',
          loggedAt: null,
          skipReason: null,
          lateNote: null,
          adminOverride: false,
          createdBy: null,
        }
      }
    }
  }

  // Overlay any logs that already exist for this date. We iterate logs per
  // treatment via a where on scheduledDate.
  for (const tDoc of treatmentsSnap.docs) {
    const logsSnap = await tDoc.ref.collection('logs')
      .where('scheduledDate', '==', date).get()
    for (const logDoc of logsSnap.docs) {
      const log = logDoc.data() as {
        slotId?: string
        patientId?: string
        status?: TSSlot['status']
        skipReason?: string | null
        lateNote?: string | null
        adminOverride?: boolean
        createdBy?: string | null
        createdAt?: FirebaseFirestore.Timestamp
      }
      const patientId = log.patientId
      const slotId = log.slotId ?? logDoc.id
      if (!patientId || !memberMap[patientId]) continue
      const slot = memberMap[patientId].slots[slotId]
      if (!slot) {
        // Log exists but the regimen no longer schedules this slot today
        // (e.g., schedule edited mid-day). Use _ = unused.
        continue
      }
      slot.status = (log.status as TSSlot['status']) ?? 'pending'
      slot.loggedAt = log.createdAt ?? null
      slot.skipReason = log.skipReason ?? null
      slot.lateNote = log.lateNote ?? null
      slot.adminOverride = log.adminOverride ?? false
      slot.createdBy = log.createdBy ?? null
    }
  }

  // Stock alerts per member, scoped to items their regimens depend on. We
  // alert on: zero stock, low stock (≤10), expired, expiring within 10 days.
  for (const [uid, member] of Object.entries(memberMap)) {
    const perItem = dailyAmountByMemberAndItem.get(uid) ?? new Map<string, number>()
    const alerts: TSStockAlert[] = []
    for (const [iId, dailyAmount] of perItem.entries()) {
      const item = itemsByIId.get(iId)
      if (!item) continue
      const qty = (item.quantityOnHand as number | undefined) ?? 0
      const expiryDate = (item.expiryDate as string | null | undefined) ?? null
      const daysSupply = dailyAmount > 0 ? Math.floor(qty / dailyAmount) : null
      let daysUntilExpiry: number | null = null
      if (expiryDate) {
        const today = new Date(`${date}T00:00:00+05:30`).getTime()
        const exp = new Date(`${expiryDate}T00:00:00+05:30`).getTime()
        daysUntilExpiry = Math.floor((exp - today) / 86400000)
      }
      const isLow = qty <= 10
      const isExpiringOrExpired = daysUntilExpiry !== null && daysUntilExpiry <= 10
      if (!isLow && !isExpiringOrExpired) continue
      alerts.push({
        cabinetItemId: iId,
        medicineName: (item.displayNameOverride as string | null | undefined)
          ?? (item.brandName as string | undefined)
          ?? (item.medicineId as string | undefined)
          ?? 'Medicine',
        quantityOnHand: qty,
        daysSupply,
        expiryDate,
        daysUntilExpiry,
      })
    }
    member.stockAlerts = alerts
  }

  // Recount before write so the persisted counts match the slots.
  for (const uid of Object.keys(memberMap)) {
    memberMap[uid] = recountMember(memberMap[uid])
  }

  await summaryRef.set({
    date,
    generatedAt: FieldValue.serverTimestamp(),
    hId,
    members: memberMap,
  })
}

// Trigger A: log doc written → update its slot in todaySummary atomically
// (read-modify-write transaction so concurrent writes don't lose updates).
export const onLogWritten = onDocumentWritten(
  {
    document: 'households/{hId}/treatments/{tId}/logs/{slotId}',
    region: 'asia-south1',
  },
  async (event) => {
    const hId = event.params.hId
    const slotId = event.params.slotId
    const after = event.data?.after?.data()
    if (!after) return  // log deleted — nothing to do (rules forbid this anyway)

    const scheduledAt = after.scheduledAt as FirebaseFirestore.Timestamp | undefined
    if (!scheduledAt) return
    const slotDateIST = toISTDateString(scheduledAt.toDate())
    const todayIST = toISTDateString(new Date())
    // Per spec — only mutate today's summary; yesterday's late logs don't
    // touch yesterday's archived doc.
    if (slotDateIST !== todayIST) return

    const summaryRef = db.doc(`households/${hId}/todaySummary/${todayIST}`)
    const summarySnap = await summaryRef.get()
    if (!summarySnap.exists) {
      // First write of the day before the cron has materialized the doc.
      // Build the full doc — it will pick up this log via the overlay pass.
      await buildTodaySummaryForHousehold(hId, todayIST)
      return
    }

    const patientId = after.patientId as string | undefined
    if (!patientId) return

    await db.runTransaction(async tx => {
      const snap = await tx.get(summaryRef)
      if (!snap.exists) return
      const data = snap.data() as { members?: Record<string, TSMember> }
      const members = { ...(data.members ?? {}) }
      const member = members[patientId]
      if (!member) return  // patient isn't tracked today — skip
      const slots = { ...member.slots }
      const existing = slots[slotId]
      if (!existing) return  // slot wasn't scheduled today — skip
      const updatedSlot: TSSlot = {
        ...existing,
        status: (after.status as TSSlot['status']) ?? 'pending',
        loggedAt: (after.createdAt as FirebaseFirestore.Timestamp | undefined) ?? null,
        skipReason: (after.skipReason as string | null | undefined) ?? null,
        lateNote: (after.lateNote as string | null | undefined) ?? null,
        adminOverride: (after.adminOverride as boolean | undefined) ?? false,
        createdBy: (after.createdBy as string | null | undefined) ?? null,
      }
      slots[slotId] = updatedSlot
      const recounted = recountMember({ ...member, slots })
      tx.update(summaryRef, {
        [`members.${patientId}`]: recounted,
        generatedAt: FieldValue.serverTimestamp(),
      })
    })
  },
)

// Trigger B: cabinet item written → refresh stockAlerts. We keep it simple
// and rebuild the whole today doc; cabinet item writes are rare relative to
// log writes, and the rebuild is bounded by household size.
export const onCabinetItemWritten = onDocumentWritten(
  {
    document: 'households/{hId}/cabinets/{cId}/items/{iId}',
    region: 'asia-south1',
  },
  async (event) => {
    const hId = event.params.hId
    const after = event.data?.after?.data()
    const before = event.data?.before?.data()
    // Only react to changes that affect alerts: quantity or expiry.
    const qtyBefore = before?.quantityOnHand
    const qtyAfter = after?.quantityOnHand
    const expBefore = before?.expiryDate
    const expAfter = after?.expiryDate
    if (qtyBefore === qtyAfter && expBefore === expAfter) return

    const todayIST = toISTDateString(new Date())
    const summaryRef = db.doc(`households/${hId}/todaySummary/${todayIST}`)
    const snap = await summaryRef.get()
    if (!snap.exists) return  // Will be created with fresh alerts on next cron / log.

    // Rebuilding is the simplest correct path; a more granular update would
    // need to iterate regimens to map iId → affected members anyway.
    await buildTodaySummaryForHousehold(hId, todayIST)
  },
)

// Trigger C: every day at 00:00 IST (= 18:30 UTC), archive yesterday's
// todaySummary and rebuild today's for every household.
export const rebuildTodaySummary = onSchedule(
  {
    schedule: '30 18 * * *',
    timeZone: 'Etc/UTC',
    region: 'asia-south1',
  },
  async () => {
    const now = new Date()
    const todayIST = toISTDateString(now)
    const yesterdayIST = toISTDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000))

    const households = await db.collection('households').get()

    // Process households in small parallel batches to avoid blowing up
    // memory on very large projects but still finish in a reasonable time.
    const batchSize = 5
    for (let i = 0; i < households.docs.length; i += batchSize) {
      const slice = households.docs.slice(i, i + batchSize)
      await Promise.all(slice.map(async hDoc => {
        const hId = hDoc.id
        // Archive yesterday if a todaySummary doc exists for it.
        const yesterdayRef = db.doc(`households/${hId}/todaySummary/${yesterdayIST}`)
        const ySnap = await yesterdayRef.get()
        if (ySnap.exists) {
          await db.doc(`households/${hId}/summaryArchive/${yesterdayIST}`).set(ySnap.data() ?? {})
        }
        // Rebuild today.
        await buildTodaySummaryForHousehold(hId, todayIST)
      }))
    }
  },
)

// Trigger D: treatment doc written → rebuild today (status / regimen scope
// changes can move slots in or out of the day).
export const onTreatmentWritten = onDocumentWritten(
  {
    document: 'households/{hId}/treatments/{tId}',
    region: 'asia-south1',
  },
  async (event) => {
    const hId = event.params.hId
    const before = event.data?.before?.data()
    const after = event.data?.after?.data()
    const statusBefore = before?.status
    const statusAfter = after?.status
    // Only rebuild on status transitions or treatment deletion. Other field
    // changes (e.g., scheduleSummary) don't affect today's slot composition.
    if (!event.data?.before?.exists && !event.data?.after?.exists) return
    if (statusBefore === statusAfter) return

    const todayIST = toISTDateString(new Date())
    await buildTodaySummaryForHousehold(hId, todayIST)
  },
)
