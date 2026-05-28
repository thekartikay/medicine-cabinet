import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore'
import { setGlobalOptions } from 'firebase-functions/v2'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { getMessaging } from 'firebase-admin/messaging'
import { randomUUID } from 'node:crypto'
import {
  todayISTDateString,
  dateInTz,
  slotInstant,
  dayOfWeekInTz,
  dayOfWeekForDateInTz,
  previousDateInTz,
} from './util/tzDate'
import { ENFORCE_APP_CHECK } from './util/enforceAppCheck'
import { SKIP_REASON_LABELS, getSkipUrgency } from './skipReasons'

// MC-004 — Gemini API proxy. Re-exported so deploy picks it up.
export { geminiProxy } from './geminiProxy'

// AK-58 — Caregiver grant Cloud Functions.
export {
  createCaregiverGrant,
  acceptCaregiverGrant,
  revokeCaregiverGrant,
  listCaregiverGrants,
} from './caregiverGrants'

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
  { enforceAppCheck: ENFORCE_APP_CHECK, region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required to join a household.')
    }
    const uid = request.auth.uid

    // AK-166 — Caller provides EITHER joinCode (legacy stateless share) OR
    // inviteId+hId (pre-staged invite, phone-bound). The inviteId path
    // skips the household scan (O(1) doc read) and copies the admin's
    // pre-staged memberName + languagePref onto the new member doc.
    const raw = (request.data ?? {}) as {
      joinCode?: unknown
      inviteId?: unknown
      hId?: unknown
    }
    const joinCode =
      typeof raw.joinCode === 'string' ? raw.joinCode.trim() : null
    const inviteId =
      typeof raw.inviteId === 'string' ? raw.inviteId.trim() : null

    if (!joinCode && !inviteId) {
      throw new HttpsError('invalid-argument', 'Provide joinCode or inviteId.')
    }
    if (joinCode && !/^\d{6}$/.test(joinCode)) {
      throw new HttpsError('invalid-argument', 'joinCode must be a 6-digit string.')
    }

    // Reject if the caller already belongs to a household.
    const userRecord = await auth.getUser(uid)
    const existingClaims = userRecord.customClaims ?? {}
    if (existingClaims.hId) {
      throw new HttpsError(
        'already-exists',
        'You already belong to a household. Leave it before joining another.',
      )
    }

    let matchedHId: string | null = null
    let matchedName: string | null = null
    // Defaults match the legacy joinCode path. Both invite branches override
    // these from the matched invite doc.
    let memberDisplayName: string | null = userRecord.displayName ?? null
    let memberLanguagePref: 'en' | 'hi' | 'kn' | 'ta' | 'te' = 'en'
    // Explicit inviteId path redeems inside the transaction (atomic with the
    // member-create). The opportunistic joinCode auto-match redeems outside
    // (best-effort — the member is already in by then, a failed redemption
    // just leaves the invite as 'pending' for the future expiry sweep).
    let inviteRefToRedeem: FirebaseFirestore.DocumentReference | null = null
    let opportunisticInviteRef: FirebaseFirestore.DocumentReference | null = null

    if (inviteId) {
      // ── AK-166 inviteId path ────────────────────────────────────────
      const hIdInput =
        typeof raw.hId === 'string' ? raw.hId.trim() : null
      if (!hIdInput) {
        throw new HttpsError('invalid-argument', 'hId is required with inviteId.')
      }

      const inviteRef = db.doc(`households/${hIdInput}/pendingInvites/${inviteId}`)
      const inviteSnap = await inviteRef.get()
      if (!inviteSnap.exists) {
        throw new HttpsError('not-found', 'Invite not found.')
      }
      const invite = inviteSnap.data() as {
        phoneE164?: string
        memberName?: string
        languagePref?: 'en' | 'hi' | 'kn' | 'ta' | 'te'
        status?: string
        expiresAt?: { toMillis: () => number }
      }

      if (invite.status !== 'pending') {
        throw new HttpsError('failed-precondition', 'Invite already used or revoked.')
      }
      if (invite.expiresAt && invite.expiresAt.toMillis() < Date.now()) {
        throw new HttpsError('failed-precondition', 'Invite has expired.')
      }
      const userPhone = userRecord.phoneNumber ?? null
      if (!userPhone || !invite.phoneE164 || userPhone !== invite.phoneE164) {
        throw new HttpsError(
          'permission-denied',
          'This invite is for a different phone number.',
        )
      }

      // Fetch the household name for the response payload.
      const hSnap = await db.doc(`households/${hIdInput}`).get()
      if (!hSnap.exists) {
        throw new HttpsError('not-found', 'Household not found.')
      }
      matchedHId = hIdInput
      matchedName = (hSnap.data()?.name as string | undefined) ?? 'Household'
      // Pre-stage the member's surface fields from the admin's input.
      memberDisplayName = invite.memberName?.trim() || memberDisplayName
      memberLanguagePref = invite.languagePref ?? memberLanguagePref
      inviteRefToRedeem = inviteRef
    } else {
      // ── Legacy joinCode path ────────────────────────────────────────
      // TODO(AK-166-followup): persist computeJoinCode(hId) as a queryable
      // field on the household doc so this becomes an O(1) lookup instead
      // of a full-collection scan. Acceptable for the beta (~10 households);
      // revisit before opening signups.
      const allHouseholds = await db.collection('households').get()
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

      // AK-166 — Opportunistic phone-match against pendingInvites for this
      // household. If the joining user's phone matches an admin-issued
      // invite, copy the pre-staged memberName + languagePref onto the
      // member doc so the invitee sees their admin-typed name rather than
      // the OTP-default. Redemption is marked outside the transaction
      // (see opportunisticInviteRef block below the runTransaction).
      if (userRecord.phoneNumber) {
        const inviteSnap = await db
          .collection(`households/${matchedHId}/pendingInvites`)
          .where('phoneE164', '==', userRecord.phoneNumber)
          .where('status', '==', 'pending')
          .limit(1)
          .get()

        if (!inviteSnap.empty) {
          const inv = inviteSnap.docs[0].data() as {
            memberName?: string
            languagePref?: 'en' | 'hi' | 'kn' | 'ta' | 'te'
            expiresAt?: { toMillis: () => number }
          }
          const expiresAtMillis = inv.expiresAt?.toMillis?.() ?? 0
          if (expiresAtMillis > Date.now()) {
            memberDisplayName = inv.memberName?.trim() || memberDisplayName
            memberLanguagePref = inv.languagePref ?? memberLanguagePref
            opportunisticInviteRef = inviteSnap.docs[0].ref
          }
        }
      }
    }

    // Atomic write: member doc + memberUids + users.householdId, and (on
    // the inviteId path) flip the invite to 'redeemed' so it can't be
    // double-consumed.
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
        displayName: memberDisplayName,
        languagePref: memberLanguagePref,
        // AK-171 — Phase 1 beta default. Profile UI in Phase 2 will let an
        // admin override on behalf of patients who live in a different zone.
        timezone: 'Asia/Kolkata',
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

      if (inviteRefToRedeem) {
        tx.update(inviteRefToRedeem, {
          status: 'redeemed',
          redeemedBy: uid,
          redeemedAt: FieldValue.serverTimestamp(),
        })
      }
    })

    // AK-166 — Post-transaction redemption for the joinCode auto-match path.
    // The member doc is already written; this is best-effort. A failed write
    // here is harmless: the member is in, and a stale 'pending' invite will
    // either expire on its own or be swept by a future cron.
    if (opportunisticInviteRef) {
      try {
        await opportunisticInviteRef.update({
          status: 'redeemed',
          redeemedBy: uid,
          redeemedAt: FieldValue.serverTimestamp(),
        })
      } catch {
        // Swallow — the join succeeded, the invite cleanup is decorative.
      }
    }

    // Set custom claims so the security rules treat this user as a member.
    await auth.setCustomUserClaims(uid, {
      ...existingClaims,
      hId: matchedHId,
      role: 'member',
    })

    return { hId: matchedHId, householdName: matchedName }
  },
)

export const createHousehold = onCall(
  { enforceAppCheck: ENFORCE_APP_CHECK },
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
        // AK-171 — Phase 1 beta default; see joinHousehold comment above.
        timezone: 'Asia/Kolkata',
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
// AK-171 — slot times are stored as "HH:MM" wall-clock; the timezone they're
// in lives on the regimen doc (`regimen.timezone`, denormalized from the
// patient's member doc at create time). slotInstant from ./util/tzDate
// resolves a (date, time, tz) triple to an absolute UTC instant; the cron
// passes the regimen's timezone into every conversion so a patient in PST
// gets their 08:00 reminder at 08:00 PT, not 08:00 IST.
//
// Older regimens predating AK-171 carry no timezone field; both crons default
// to 'Asia/Kolkata' for those, preserving prior behaviour during rollout.

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

          // AK-171 — patient's timezone is denormalized onto the regimen at
          // create time. Pre-AK-171 docs fall back to IST so the cron stays
          // correct during the rollout. todayInTz/dowInTz drive start-date /
          // end-date / specific-days filtering in the patient's local time.
          const regimenTz = (regimen.timezone as string | undefined) ?? 'Asia/Kolkata'
          const todayInTz = dateInTz(now, regimenTz)
          const dowInTz = dayOfWeekInTz(now, regimenTz)

          // Skip regimens that aren't active today or aren't time-driven.
          const scheduleType = regimen.scheduleType as string | undefined
          if (scheduleType === 'as-needed') continue
          if (regimen.startDate && regimen.startDate > todayInTz) continue
          if (regimen.endDate && regimen.endDate < todayInTz) continue
          if (scheduleType === 'specific-days') {
            const days = regimen.scheduleDays as number[] | undefined
            if (!days?.includes(dowInTz)) continue
          }

          // AK-131 — flexible-daily fires its reminder at the 09:00 anchor
          // in the patient's local time. The body copy reminds the user they
          // can log the dose at any point in the day; the slotId carries the
          // `-flex` suffix that pairs with the synthetic todaySummary slot.
          if (scheduleType === 'flexible-daily') {
            const flexTime = '09:00'
            const instant = slotInstant(todayInTz, flexTime, regimenTz)
            if (instant < windowStart || instant > windowEnd) continue
            // AK-171 — slotId date stays IST-anchored (per AK-171 Phase 1
            // constraint: rewriting slot IDs would orphan existing logs).
            // dateInTz on the actual UTC instant gives a stable IST date
            // that matches what the client computes via todayISTString().
            const slotIdDate = dateInTz(instant, 'Asia/Kolkata')
            const slotId = `${tId}-${rId}-${patientId}-${slotIdDate}-flex`

            const logSnap = await db
              .doc(`households/${hId}/treatments/${tId}/logs/${slotId}`)
              .get()
            if (logSnap.exists) continue

            const userData = await getUser(patientId)
            if (!userData?.fcmToken) continue
            if (userData.pushNotificationsEnabled === false) continue

            const medicineName = (regimen.displayName as string | undefined)
              ?? 'your medicine'

            try {
              await messaging.send({
                token: userData.fcmToken,
                notification: {
                  title: `Don't forget — ${medicineName}`,
                  body: `Take it any time before midnight.`,
                },
                data: {
                  slotId,
                  treatmentId: tId,
                  householdId: hId,
                  patientId,
                  medicineName,
                  type: 'dose_reminder',
                },
                android: {
                  priority: 'high',
                  ttl: 14 * 60 * 60 * 1000,
                  notification: {
                    channelId: 'dose_reminders',
                    color: '#5DC1C8',
                    tag: slotId,
                    icon: 'ic_notification',
                  },
                },
                apns: {
                  headers: {
                    'apns-collapse-id': slotId,
                    'apns-priority': '10',
                  },
                  payload: {
                    aps: {
                      sound: 'default',
                      badge: 1,
                      mutableContent: true,
                      'interruption-level': 'time-sensitive',
                    },
                  },
                },
              })
            } catch (err: unknown) {
              const code = (err as { code?: string })?.code
              if (code === 'messaging/registration-token-not-registered') {
                await db.doc(`users/${patientId}`).update({
                  fcmToken: FieldValue.delete(),
                })
                userCache.delete(patientId)
              }
            }
            continue
          }

          const slots = (regimen.slots ?? []) as Array<{ time: string; foodTiming?: string }>
          for (const slot of slots) {
            if (typeof slot.time !== 'string' || !/^\d{2}:\d{2}$/.test(slot.time)) continue
            // AK-171 — slot wall-clock is interpreted in regimenTz; the actual
            // UTC instant is what the windowStart/End check compares against.
            const instant = slotInstant(todayInTz, slot.time, regimenTz)
            if (instant < windowStart || instant > windowEnd) continue

            const hhmm = slot.time.replace(':', '')
            // AK-171 — slotId date stays IST-anchored (see flex-branch note above).
            const slotIdDate = dateInTz(instant, 'Asia/Kolkata')
            const slotId = `${tId}-${rId}-${patientId}-${slotIdDate}-${hhmm}`

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
                  patientId,
                  medicineName,
                  scheduledTime: slot.time,
                  type: 'dose_reminder',
                },
                android: {
                  priority: 'high',
                  ttl: 90 * 60 * 1000,
                  notification: {
                    channelId: 'dose_reminders',
                    color: '#5DC1C8',
                    tag: slotId,
                    icon: 'ic_notification',
                    clickAction: 'OPEN_DOSE_CARD',
                  },
                },
                apns: {
                  headers: {
                    'apns-collapse-id': slotId,
                    'apns-priority': '10',
                  },
                  payload: {
                    aps: {
                      sound: 'default',
                      badge: 1,
                      mutableContent: true,
                      'interruption-level': 'time-sensitive',
                    },
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
  { enforceAppCheck: ENFORCE_APP_CHECK, region: 'asia-south1' },
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
  { enforceAppCheck: ENFORCE_APP_CHECK, region: 'asia-south1' },
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
          slotId,
        },
        android: {
          priority: 'high',
          ttl: 90 * 60 * 1000,
          notification: {
            channelId: 'dose_reminders',
            color: '#5DC1C8',
            tag: slotId,
            icon: 'ic_notification',
          },
        },
        apns: {
          headers: {
            'apns-collapse-id': slotId,
            'apns-priority': '10',
          },
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              mutableContent: true,
              'interruption-level': 'time-sensitive',
            },
          },
        },
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
    // AK-171 — `dates` (yesterday + today) is now computed per regimen, in
    // the regimen's timezone, so non-IST patients don't miss late-night slots
    // that already rolled over IST midnight but not their own. See per-regimen
    // block below.

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
      // AK-173 — adminIds no longer needed here; sendDailyMissedDigest at
      // 19:30 IST owns admin fan-out and reads adminIds at its own scope.

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

          // AK-171 — per-regimen timezone (denormalized from the patient's
          // member doc). `dates` is yesterday + today in the patient's local
          // time, so the iteration covers the right pair of calendar days
          // regardless of when the cron fires relative to UTC.
          const regimenTz = (regimen.timezone as string | undefined) ?? 'Asia/Kolkata'
          const todayInTz = dateInTz(now, regimenTz)
          const yesterdayInTz = previousDateInTz(todayInTz, regimenTz)
          const dates = [yesterdayInTz, todayInTz]

          const scheduleType = regimen.scheduleType as string | undefined
          if (scheduleType === 'as-needed') continue

          const slots = (regimen.slots ?? []) as Array<{ time: string; foodTiming?: string }>
          // AK-131 — flexible-daily has no fixed slots but does need a missed
          // sweep. The end-of-day cutoff is 23:30 in the patient's local time
          // (+ 30-min grace ⇒ marked missed shortly after their midnight).
          // The log's scheduledAt is recorded at the 09:00 anchor so the rest
          // of the system reads it as a regular dose.
          if (scheduleType === 'flexible-daily') {
            for (const dateStr of dates) {
              if (regimen.startDate && regimen.startDate > dateStr) continue
              if (regimen.endDate && regimen.endDate < dateStr) continue

              const endOfDayInstant = slotInstant(dateStr, '23:30', regimenTz)
              if (endOfDayInstant > now) continue
              if (endOfDayInstant >= cutoff) continue

              const scheduledAtFlex = slotInstant(dateStr, '09:00', regimenTz)
              // AK-171 — slotId date stays IST-anchored (matches what the
              // client and the dose-reminder cron compute for the same slot).
              const slotIdDate = dateInTz(scheduledAtFlex, 'Asia/Kolkata')
              const slotId = `${tId}-${rId}-${patientId}-${slotIdDate}-flex`
              const logRef = db.doc(`households/${hId}/treatments/${tId}/logs/${slotId}`)

              try {
                await logRef.create({
                  slotId,
                  tId,
                  rId,
                  hId,
                  patientId,
                  scheduledAt: Timestamp.fromDate(scheduledAtFlex),
                  scheduledDate: slotIdDate,
                  scheduledTime: '09:00',
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
                if (code === 6 || code === 'already-exists') continue
                throw err
              }

              const medicineName = (regimen.displayName as string | undefined) ?? 'their medicine'
              const patient = await getUser(patientId)
              const patientName = (patient?.displayName as string | undefined) ?? 'A family member'

              const notifId = `missed_${slotId}`
              try {
                await db.doc(`households/${hId}/notifications/${notifId}`).create({
                  notifId,
                  type: 'missed_dose',
                  message: `${patientName} missed their ${medicineName} (any-time-today)`,
                  createdAt: FieldValue.serverTimestamp(),
                  readBy: [],
                  relatedMemberId: patientId,
                  relatedMedicineId: (regimen.cabinetItemId as string | undefined) ?? null,
                })
              } catch {
                // Same swallow as the fixed-time branch — admin still sees the
                // missed log in the dashboard.
              }

              // AK-173 — Per-miss admin push removed; sendDailyMissedDigest
              // fans out one batched push per patient at 19:30 IST instead.
              // The in-app notification doc above still lights up the bell.
            }
            continue
          }

          if (slots.length === 0) continue

          for (const dateStr of dates) {
            if (regimen.startDate && regimen.startDate > dateStr) continue
            if (regimen.endDate && regimen.endDate < dateStr) continue
            if (scheduleType === 'specific-days') {
              const days = regimen.scheduleDays as number[] | undefined
              if (!days?.includes(dayOfWeekForDateInTz(dateStr, regimenTz))) continue
            }

            for (const slot of slots) {
              if (typeof slot.time !== 'string' || !/^\d{2}:\d{2}$/.test(slot.time)) continue
              const instant = slotInstant(dateStr, slot.time, regimenTz)
              // Only mark slots that have already fired AND are past the
              // 30-minute grace window.
              if (instant > now) continue
              if (instant >= cutoff) continue

              const hhmm = slot.time.replace(':', '')
              // AK-171 — slotId date stays IST-anchored; see flex branch note.
              const slotIdDate = dateInTz(instant, 'Asia/Kolkata')
              const slotId = `${tId}-${rId}-${patientId}-${slotIdDate}-${hhmm}`
              const logRef = db.doc(`households/${hId}/treatments/${tId}/logs/${slotId}`)

              try {
                await logRef.create({
                  slotId,
                  tId,
                  rId,
                  hId,
                  patientId,
                  scheduledAt: Timestamp.fromDate(instant),
                  scheduledDate: slotIdDate,
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
              // Best-effort — a failed notification write must not break the
              // missed-log creation above.
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

              // AK-173 — Per-miss admin push removed; sendDailyMissedDigest
              // fans out one batched push per patient at 19:30 IST instead.
              // The in-app notification doc above still lights up the bell.
            }
          }
        }
      }
    }
  },
)

// ─── sendDailyMissedDigest (AK-173) ─────────────────────────────────────────
// Daily 19:30 IST roll-up. Replaces the per-miss admin push that
// markMissedDoses used to fan out throughout the day (one push per missed
// slot, often 3-5 buzzes per household per day). Instead, each admin gets
// at most ONE push per patient per day, summarising the day's misses with
// a softened "Heads up:" opener.
//
// Reads today's pre-aggregated todaySummary doc (TodaySummaryMember.missedCount
// is already counted by maintainTodaySummary / buildTodaySummaryForHousehold)
// rather than re-scanning logs.
export const sendDailyMissedDigest = onSchedule(
  {
    schedule: '30 19 * * *',
    timeZone: 'Asia/Kolkata',
    region: 'asia-south1',
    minInstances: 0,
  },
  async () => {
    const now = new Date()
    const todayIST = todayISTDateString(now)

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
      if (adminIds.length === 0) continue

      const summarySnap = await db
        .doc(`households/${hId}/todaySummary/${todayIST}`)
        .get()
      if (!summarySnap.exists) continue
      const summary = summarySnap.data() as {
        members?: Record<string, {
          displayName?: string
          missedCount?: number
          slots?: Record<string, { status?: string; medicineName?: string }>
        }>
      }

      for (const [patientId, member] of Object.entries(summary.members ?? {})) {
        const missedCount = member.missedCount ?? 0
        if (missedCount === 0) continue

        const patientName = member.displayName?.trim() || 'A family member'

        // For the single-miss copy, surface the actual medicine name so the
        // body reads as a specific reminder rather than a generic count.
        let singleMedicineName: string | null = null
        if (missedCount === 1) {
          for (const slot of Object.values(member.slots ?? {})) {
            if (slot.status === 'missed') {
              singleMedicineName = slot.medicineName ?? null
              break
            }
          }
        }

        const title =
          `${patientName} missed ${missedCount} dose${missedCount > 1 ? 's' : ''} today`
        const body =
          missedCount === 1 && singleMedicineName
            ? `Heads up: ${patientName} hasn't logged their ${singleMedicineName} today`
            : `Heads up: ${patientName} missed ${missedCount} doses today`

        const tag = `digest-${hId}-${patientId}`

        for (const adminId of adminIds) {
          const adminData = await getUser(adminId)
          if (!adminData?.fcmToken) continue
          if (adminData.pushNotificationsEnabled === false) continue

          try {
            await messaging.send({
              token: adminData.fcmToken as string,
              notification: { title, body },
              data: {
                type: 'daily_missed_digest',
                patientId,
                householdId: hId,
                missedCount: String(missedCount),
              },
              android: {
                priority: 'high',
                ttl: 4 * 60 * 60 * 1000,
                notification: {
                  channelId: 'dose_reminders',
                  color: '#5DC1C8',
                  tag,
                  icon: 'ic_notification',
                },
              },
              apns: {
                headers: {
                  'apns-collapse-id': tag,
                  'apns-priority': '10',
                },
                payload: {
                  aps: {
                    sound: 'default',
                    badge: 1,
                    mutableContent: true,
                    'interruption-level': 'time-sensitive',
                  },
                },
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
            // Otherwise swallow — one bad admin shouldn't abort the digest.
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
  { enforceAppCheck: ENFORCE_APP_CHECK, region: 'asia-south1' },
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
  // AK-131 — null when scheduleType is 'flexible-daily' (no fixed time).
  scheduledTime: string | null
  doseAmount: number
  doseUnit: string
  // AK-131 — null when scheduleType is 'flexible-daily' (food timing dropped).
  foodTiming: string | null
  cabinetItemId: string
  status: 'taken' | 'late' | 'skipped' | 'missed' | 'pending'
  loggedAt: FirebaseFirestore.Timestamp | null
  skipReason: string | null
  // AK-154 — free text for skipReason === 'other'; mirrored from the log.
  skipReasonText: string | null
  lateNote: string | null
  adminOverride: boolean
  createdBy: string | null
  // AK-131 — Discriminator so the client renderer can detect flexible-daily
  // without inferring from scheduledTime. Absent on legacy slot docs.
  scheduleType?: string
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

// Local alias kept for readability inside the maintainTodaySummary block.
// Points at the shared util so this file and the cron stay aligned.
const toISTDateString = todayISTDateString

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

  const [treatmentsSnap, membersSnap, cabinetsSnap, priorSnap] = await Promise.all([
    db.collection(`households/${hId}/treatments`).where('status', '==', 'active').get(),
    db.collection(`households/${hId}/members`).get(),
    db.collection(`households/${hId}/cabinets`).get(),
    summaryRef.get(),
  ])

  // AK-130 — Snapshot the prior summary so a regimen whose schedule was edited
  // *today* can carry its today slots forward verbatim (tomorrow-IST guard in
  // the regimen loop below). This is a full-rebuild-and-overwrite function, so
  // without carrying forward, the rebuild would replace today's old-schedule
  // slots with the freshly-edited schedule.
  const priorDocExisted = priorSnap.exists
  const priorSlotsByRegimen = new Map<string, Array<[string, TSSlot]>>()
  if (priorDocExisted) {
    const priorMembers = (priorSnap.data()?.members ?? {}) as Record<string, { slots?: Record<string, TSSlot> }>
    for (const m of Object.values(priorMembers)) {
      for (const [slotId, slot] of Object.entries(m.slots ?? {})) {
        if (!slot.regimenId) continue
        const arr = priorSlotsByRegimen.get(slot.regimenId) ?? []
        arr.push([slotId, slot])
        priorSlotsByRegimen.set(slot.regimenId, arr)
      }
    }
  }

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
        timezone?: string
        scheduleChangedAt?: FirebaseFirestore.Timestamp
      }
      const scheduleType = r.scheduleType
      if (scheduleType === 'as-needed') continue
      if (r.startDate && r.startDate > date) continue
      if (r.endDate && r.endDate < date) continue

      // AK-130 — tomorrow-IST guard. If this regimen's schedule changed after
      // the start of *today* (in the regimen's timezone), freeze today: carry
      // the pre-edit slots forward from the prior summary and skip generating
      // the new schedule. On tomorrow's date scheduleChangedAt < startOfToday,
      // so the new schedule applies normally. Only fixed-time slots are
      // affected — PRN (as-needed) already `continue`d above and has no slots.
      {
        const regTz = r.timezone ?? 'Asia/Kolkata'
        const changedAt = r.scheduleChangedAt
        const startOfTodayMs = slotInstant(date, '00:00', regTz).getTime()
        if (changedAt != null && changedAt.toMillis() > startOfTodayMs && priorDocExisted) {
          const guardedMember = ensureMember(patientId)
          for (const [slotId, slot] of priorSlotsByRegimen.get(rId) ?? []) {
            guardedMember.slots[slotId] = { ...slot }
            // Keep daysSupply accurate against the carried (old-schedule) doses.
            if (slot.cabinetItemId && slot.doseAmount > 0) {
              let perItem = dailyAmountByMemberAndItem.get(patientId)
              if (!perItem) { perItem = new Map(); dailyAmountByMemberAndItem.set(patientId, perItem) }
              perItem.set(slot.cabinetItemId, (perItem.get(slot.cabinetItemId) ?? 0) + slot.doseAmount)
            }
          }
          continue
        }
      }

      if (scheduleType === 'specific-days') {
        if (!r.scheduleDays?.includes(dowIST)) continue
      }

      const member = ensureMember(patientId)
      const slots = r.slots ?? []
      const slotsPerDay = slots.length
      const doseAmount = r.doseAmount ?? 0
      const cabinetItemId = r.cabinetItemId ?? ''

      // AK-131 — flexible-daily synthesises exactly one slot per day with a
      // `-flex` slotId, scheduledTime/foodTiming null, and the scheduleType
      // discriminator. Counts as one dose toward daysSupply.
      if (scheduleType === 'flexible-daily') {
        const slotId = `${tId}-${rId}-${patientId}-${date}-flex`
        member.slots[slotId] = {
          treatmentId: tId,
          treatmentName: t.name ?? 'Treatment',
          regimenId: rId,
          medicineName: r.displayName ?? 'Medicine',
          scheduledTime: null,
          doseAmount,
          doseUnit: r.doseUnit ?? '',
          foodTiming: null,
          cabinetItemId,
          status: 'pending',
          loggedAt: null,
          skipReason: null,
          skipReasonText: null,
          lateNote: null,
          adminOverride: false,
          createdBy: null,
          scheduleType: 'flexible-daily',
        }
        if (cabinetItemId && doseAmount > 0) {
          let perItem = dailyAmountByMemberAndItem.get(patientId)
          if (!perItem) {
            perItem = new Map()
            dailyAmountByMemberAndItem.set(patientId, perItem)
          }
          perItem.set(
            cabinetItemId,
            (perItem.get(cabinetItemId) ?? 0) + doseAmount,
          )
        }
        continue
      }

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
          skipReasonText: null,
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
        skipReasonText?: string | null
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
      slot.skipReasonText = log.skipReasonText ?? null
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

// AK-154 — IST hour:minute formatter for the late-dose push copy.
function formatISTTimeOfDay(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

// AK-155 — Best-effort: zero a cabinet item's stock when a dose is skipped for
// "ran out" / "inhaler empty". Conditional write in a transaction so we only
// touch items that still show stock; never throws (warn + swallow) so it can't
// block the caregiver FCM. Items live in the household's default cabinet
// (mirrors getDefaultCabinetId = `${hId}-default` in src/lib/paths.ts).
async function zeroCabinetItemStock(
  hId: string,
  cabinetItemId: string | undefined,
): Promise<void> {
  if (!cabinetItemId) return
  const itemRef = db.doc(`households/${hId}/cabinets/${hId}-default/items/${cabinetItemId}`)
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(itemRef)
      if (!snap.exists) return
      const qty = (snap.data()?.quantityOnHand as number | undefined) ?? 0
      if (qty > 0) {
        tx.update(itemRef, {
          quantityOnHand: 0,
          updatedAt: FieldValue.serverTimestamp(),
        })
      }
    })
  } catch (err: unknown) {
    console.warn(
      `zeroCabinetItemStock: ${hId} — failed to zero ${cabinetItemId}: ${String(err)}`,
    )
  }
}

// AK-154 — Fire a caregiver/admin push when a member skips (non-PRN) or logs a
// late dose, then stamp caregiverNotifiedAt on the log. The stamp re-triggers
// onLogWritten; the guard below sees the (truthy) timestamp and returns, so we
// never double-send or loop. PRN skips and taken/missed/pending writes never
// reach the send path. Best-effort: a failed push must not throw.
async function notifyCaregiverOnLog(
  hId: string,
  tId: string,
  slotId: string,
  after: FirebaseFirestore.DocumentData,
): Promise<void> {
  const status = after.status as string | undefined
  if (status !== 'skipped' && status !== 'late') return
  // Re-fire from our own caregiverNotifiedAt stamp — stop here.
  if (after.caregiverNotifiedAt) return

  const patientId = after.patientId as string | undefined
  if (!patientId) return

  const tSnap = await db.doc(`households/${hId}/treatments/${tId}`).get()
  const treatment = tSnap.data() as { category?: string; memberName?: string } | undefined
  const category = treatment?.category
  const patientName = treatment?.memberName?.trim() || 'A family member'

  // PRN skips are silent to caregivers ("not taking today" is expected).
  if (status === 'skipped' && category === 'prn') return

  // Medicine name from the regimen (the log doc doesn't denormalise it).
  const rId = after.rId as string | undefined
  let medicineName = 'their medicine'
  if (rId) {
    const rSnap = await db.doc(`households/${hId}/treatments/${tId}/regimens/${rId}`).get()
    const dn = rSnap.data()?.displayName as string | undefined
    if (dn && dn.trim()) medicineName = dn.trim()
  }

  let title: string
  let body: string
  let highPriority = false
  if (status === 'late') {
    const takenAt = after.takenAt as FirebaseFirestore.Timestamp | undefined
    const when = takenAt ? formatISTTimeOfDay(takenAt.toDate()) : 'earlier today'
    title = `${patientName} logged a late dose`
    body = `${medicineName} — taken at ${when}.`
  } else {
    // AK-155 — three-tier routing by skip-reason urgency.
    const reasonId = (after.skipReason as string | null | undefined) ?? null
    const reasonLabel = reasonId ? (SKIP_REASON_LABELS[reasonId] ?? null) : null
    const tier = getSkipUrgency(reasonId)

    // 🟢 Benign skips are silent — no push, and we deliberately do NOT stamp
    // caregiverNotifiedAt (nothing was sent, so the log stays "unnotified").
    if (tier === 'benign') return

    if (tier === 'clinical') {
      // 🔴 high-priority / critical
      title = `⚠️ ${patientName} skipped ${medicineName}`
      body = `${reasonLabel ?? 'Dose skipped'} — check in when you can`
      highPriority = true
    } else {
      // 🟡 informational — normal priority
      if (reasonId === 'ran_out' || reasonId === 'inhaler_empty') {
        title = `${patientName} is out of ${medicineName}`
        body = 'Tap to request a refill.'
      } else {
        title = `${patientName} skipped ${medicineName}`
        body = reasonLabel ?? 'No reason given.'
      }
    }

    // AK-155 Step 3 — "ran out" / "inhaler empty" zeroes the cabinet item's
    // stock so the existing low-stock alert pipeline (onCabinetItemWritten →
    // stockAlerts) picks it up. Best-effort: a failure must not block the FCM.
    if (reasonId === 'ran_out' || reasonId === 'inhaler_empty') {
      await zeroCabinetItemStock(hId, after.cabinetItemId as string | undefined)
    }
  }

  const hSnap = await db.doc(`households/${hId}`).get()
  const household = hSnap.data() as
    { adminIds?: string[]; primaryAdminId?: string } | undefined
  const adminIds = household?.adminIds ?? []
  const primaryAdminId = household?.primaryAdminId
  const createdBy = after.createdBy as string | undefined
  const dataType = status === 'late' ? 'late_dose' : 'dose_skipped'

  // AK-154 follow-up — when the primary admin logs (or skips) their OWN dose,
  // don't push a notification back at themselves; route to every OTHER admin
  // instead. All other logs (members, co-admins acting on a member) notify the
  // full admin set as before.
  const isAdminLoggingOwnDose =
    !!primaryAdminId && patientId === primaryAdminId && createdBy === patientId
  const recipientIds = isAdminLoggingOwnDose
    ? adminIds.filter(uid => uid !== patientId)
    : adminIds

  if (recipientIds.length === 0) {
    // Admin logged their own dose and is the sole admin — no one to notify.
    if (isAdminLoggingOwnDose) {
      console.warn(
        `notifyCaregiverOnLog: ${hId} — admin logged own dose but has no co-admin to notify`,
      )
    }
    return
  }

  let sent = 0
  for (const adminId of recipientIds) {
    const adminSnap = await db.doc(`users/${adminId}`).get()
    const adminData = adminSnap.data()
    if (!adminData?.fcmToken) continue
    if (adminData.pushNotificationsEnabled === false) continue
    try {
      await messaging.send({
        token: adminData.fcmToken as string,
        notification: { title, body },
        data: { type: dataType, householdId: hId, patientId, slotId },
        android: {
          priority: highPriority ? 'high' : 'normal',
          notification: {
            channelId: 'dose_reminders',
            color: '#5DC1C8',
            icon: 'ic_notification',
          },
        },
        apns: {
          headers: { 'apns-priority': highPriority ? '10' : '5' },
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              mutableContent: true,
              'interruption-level': highPriority ? 'critical' : 'active',
            },
          },
        },
      })
      sent++
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'messaging/registration-token-not-registered') {
        await db.doc(`users/${adminId}`).update({ fcmToken: FieldValue.delete() })
      }
      // Otherwise swallow — one bad token shouldn't block the rest.
    }
  }

  // AK-154 follow-up — co-admin(s) exist but none had a registered FCM token.
  // Surface it for diagnostics; still return cleanly (never throw).
  if (isAdminLoggingOwnDose && sent === 0) {
    console.warn(
      `notifyCaregiverOnLog: ${hId} — admin logged own dose but no co-admin has a registered FCM token`,
    )
  }

  // Stamp so the re-triggered onLogWritten bails at the guard above. Done even
  // with no tokens so this log's notification is never reprocessed.
  await db.doc(`households/${hId}/treatments/${tId}/logs/${slotId}`).update({
    caregiverNotifiedAt: Timestamp.now(),
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

    // AK-154 — caregiver skip/late push. Runs before the summary read/build so
    // it still fires on the household's very first log of the day.
    await notifyCaregiverOnLog(hId, event.params.tId, slotId, after)

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
        skipReasonText: (after.skipReasonText as string | null | undefined) ?? null,
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

// ─── MC-017a — DPDP account deletion ─────────────────────────────────────────
// Three-piece flow:
//   1. deleteAccount (callable)        — soft-delete: stamp deletedAt + a
//      30-day deletionScheduledFor on users/{uid}, remove the uid from any
//      household membership lists, revoke custom claims, and clear FCM
//      tokens. Returns the hard-delete timestamp so the client can show it.
//   2. restoreAccount (callable)       — within the 30-day window, the user
//      signs back in and confirms restoration. We clear deletedAt and
//      deletionScheduledFor. Re-attaching to the household requires the
//      memberUids/adminIds entries we removed at soft-delete time, so we
//      use deletionHouseholds[] (captured then) to put them back.
//   3. purgeDeletedAccounts (schedule) — daily 03:00 IST. For every user
//      whose deletionScheduledFor is in the past, hard-delete: dose logs
//      authored by uid (across the user's known households), the users doc,
//      the aiLogs subtree, and the Auth account. Inventory audits and the
//      consentLog/{uid} record are intentionally preserved (anonymised) so
//      the legal audit trail survives the purge.
//
// All three respect CLAUDE.md rule 9 (enforceAppCheck) for the callables.
// The scheduled function isn't user-callable so App Check doesn't apply.

const DELETION_GRACE_DAYS = 30

// Walks the user's known households and strips their uid from memberUids and
// adminIds. The membership list is captured at soft-delete time so the same
// households can be restored later. We use a transaction per household so the
// two arrayRemove ops land atomically with the audit-friendly read.
async function detachUserFromHouseholds(uid: string, hIds: string[]): Promise<void> {
  for (const hId of hIds) {
    const ref = db.doc(`households/${hId}`)
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref)
        if (!snap.exists) return
        tx.update(ref, {
          memberUids: FieldValue.arrayRemove(uid),
          adminIds: FieldValue.arrayRemove(uid),
        })
      })
    } catch {
      // One bad household shouldn't block the rest. Surface via logs only.
    }
    // Delete the member sub-doc so the user disappears from the roster.
    try {
      await db.doc(`households/${hId}/members/${uid}`).delete()
    } catch {
      // Already gone or not present — fine.
    }
  }
}

// Resolves every household the user has any record of being in. We prefer
// users/{uid}.householdId (current), fall back to scanning members groups
// only if needed.
async function resolveUserHouseholds(uid: string, userData: FirebaseFirestore.DocumentData | undefined): Promise<string[]> {
  const seen = new Set<string>()
  const direct = userData?.householdId as string | undefined
  if (direct) seen.add(direct)
  const stamped = userData?.deletionHouseholds as string[] | undefined
  if (stamped) for (const h of stamped) seen.add(h)
  return [...seen]
}

export const deleteAccount = onCall(
  { enforceAppCheck: ENFORCE_APP_CHECK, region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required to delete your account.')
    }
    const uid = request.auth.uid

    const raw = (request.data ?? {}) as { confirmation?: unknown }
    if (raw.confirmation !== 'DELETE_MY_ACCOUNT') {
      throw new HttpsError(
        'failed-precondition',
        'Confirmation string did not match. Type DELETE in the app to proceed.',
      )
    }

    const userRef = db.doc(`users/${uid}`)
    const userSnap = await userRef.get()
    const userData = userSnap.data()
    const households = await resolveUserHouseholds(uid, userData)

    // 1. Detach from households first. If this fails halfway, the user can
    //    re-trigger deletion; idempotent because arrayRemove on a missing
    //    member is a no-op.
    await detachUserFromHouseholds(uid, households)

    // 2. Soft-delete the user doc with the recovery window. We stamp
    //    deletionHouseholds so restoreAccount and the purge cron know
    //    where to look without consulting the per-household members
    //    collection (which we just emptied).
    const scheduledFor = Timestamp.fromMillis(
      Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    )
    await userRef.set(
      {
        deletedAt: FieldValue.serverTimestamp(),
        deletionScheduledFor: scheduledFor,
        deletionHouseholds: households,
        // Cleared so the user stops receiving FCM notifications during the
        // grace period. Both shapes (single + multi-device) are blanked.
        fcmToken: FieldValue.delete(),
        fcmTokens: [],
        // Removing householdId frees the user to join a different
        // household if they later create a fresh account; the old data
        // will still be purged by the cron.
        householdId: FieldValue.delete(),
      },
      { merge: true },
    )

    // 3. Revoke custom claims so the user cannot read household-scoped data
    //    while soft-deleted. Setting to {} drops hId/role; the rules will
    //    treat them as a stranger to the household.
    await auth.setCustomUserClaims(uid, {})
    // Force any active sessions to refresh their token on next read.
    await auth.revokeRefreshTokens(uid)

    return {
      status: 'scheduled',
      hardDeleteAt: scheduledFor.toMillis(),
    }
  },
)

export const restoreAccount = onCall(
  { enforceAppCheck: ENFORCE_APP_CHECK, region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required to restore your account.')
    }
    const uid = request.auth.uid

    const userRef = db.doc(`users/${uid}`)
    const userSnap = await userRef.get()
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'No account found.')
    }
    const userData = userSnap.data() ?? {}
    if (!userData.deletedAt) {
      throw new HttpsError('failed-precondition', 'Account is not pending deletion.')
    }
    const scheduled = userData.deletionScheduledFor as FirebaseFirestore.Timestamp | undefined
    if (scheduled && scheduled.toMillis() <= Date.now()) {
      // Already past the cutoff — purge may have run, or be about to. Refuse
      // rather than half-restore.
      throw new HttpsError('failed-precondition', 'Recovery window has expired.')
    }

    const households = (userData.deletionHouseholds as string[] | undefined) ?? []

    // Pick the first known household to re-attach to. Most users have one.
    // If they had multiple, the rest are dropped; that matches the soft-
    // delete semantics where we only remove their uid — not the household
    // itself. The user can re-join any other households via the join code.
    const primaryHId = households[0]
    let restoredRole: 'admin' | 'member' = 'member'
    if (primaryHId) {
      const hSnap = await db.doc(`households/${primaryHId}`).get()
      if (hSnap.exists) {
        const hData = hSnap.data() as { adminIds?: string[]; primaryAdminId?: string }
        // primaryAdminId is the source of truth for "this user used to be the
        // admin" — we restore them to that role if they were the primary.
        const wasAdmin = hData.primaryAdminId === uid
          || (hData.adminIds ?? []).includes(uid)
        restoredRole = wasAdmin ? 'admin' : 'member'

        await db.runTransaction(async tx => {
          tx.set(
            db.doc(`households/${primaryHId}/members/${uid}`),
            {
              uid,
              hId: primaryHId,
              role: restoredRole,
              displayName: userData.displayName ?? null,
              joinedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          )
          const updates: Record<string, unknown> = {
            memberUids: FieldValue.arrayUnion(uid),
          }
          if (restoredRole === 'admin') {
            updates.adminIds = FieldValue.arrayUnion(uid)
          }
          tx.update(db.doc(`households/${primaryHId}`), updates)
        })
      }
    }

    await userRef.set(
      {
        deletedAt: FieldValue.delete(),
        deletionScheduledFor: FieldValue.delete(),
        deletionHouseholds: FieldValue.delete(),
        ...(primaryHId ? { householdId: primaryHId } : {}),
      },
      { merge: true },
    )

    if (primaryHId) {
      await auth.setCustomUserClaims(uid, { hId: primaryHId, role: restoredRole })
    }

    return { ok: true, hId: primaryHId ?? null, role: restoredRole }
  },
)

// Daily 03:00 IST = 21:30 UTC. Scans users where deletedAt is set AND the
// scheduled hard-delete instant is in the past, and removes their data.
// Anonymises but does NOT delete inventoryAudits authored by uid and the
// consentLog/{uid} record (compliance).
export const purgeDeletedAccounts = onSchedule(
  {
    schedule: '30 21 * * *',
    timeZone: 'Etc/UTC',
    region: 'asia-south1',
  },
  async () => {
    const now = Timestamp.now()
    const usersSnap = await db.collection('users')
      .where('deletionScheduledFor', '<=', now)
      .get()

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id
      const data = userDoc.data() as {
        deletedAt?: FirebaseFirestore.Timestamp
        deletionHouseholds?: string[]
      }
      if (!data.deletedAt) continue
      const households = data.deletionHouseholds ?? []

      // 1. Hard-delete dose logs authored by this uid across known households.
      for (const hId of households) {
        const treatments = await db.collection(`households/${hId}/treatments`).get()
        for (const tDoc of treatments.docs) {
          const logsSnap = await tDoc.ref.collection('logs')
            .where('createdBy', '==', uid)
            .get()
          for (let i = 0; i < logsSnap.docs.length; i += 499) {
            const batch = db.batch()
            for (const logDoc of logsSnap.docs.slice(i, i + 499)) {
              batch.delete(logDoc.ref)
            }
            await batch.commit()
          }
        }
        // Anonymise inventoryAudits authored by uid (preserve the row).
        const auditsSnap = await db.collection(`households/${hId}/inventoryAudits`)
          .where('authoredBy', '==', uid)
          .get()
        for (let i = 0; i < auditsSnap.docs.length; i += 499) {
          const batch = db.batch()
          for (const a of auditsSnap.docs.slice(i, i + 499)) {
            batch.update(a.ref, { authoredBy: 'deleted-user' })
          }
          await batch.commit()
        }
      }

      // 2. Delete the aiLogs/{uid}/queries/* subtree.
      const aiQueriesSnap = await db.collection(`aiLogs/${uid}/queries`).get()
      for (let i = 0; i < aiQueriesSnap.docs.length; i += 499) {
        const batch = db.batch()
        for (const q of aiQueriesSnap.docs.slice(i, i + 499)) {
          batch.delete(q.ref)
        }
        await batch.commit()
      }
      try {
        await db.doc(`aiLogs/${uid}`).delete()
      } catch {
        // No parent doc — ignore.
      }

      // 3. Compliance audit row first (so a partial failure still leaves a
      //    record that the purge ran for this uid).
      try {
        await db.doc(`deletionAudit/${uid}`).set({
          uid,
          purgedAt: FieldValue.serverTimestamp(),
          households,
        })
      } catch {
        // Best-effort.
      }

      // 4. Delete the user profile doc. consentLog/{uid} is left in place.
      try {
        await db.doc(`users/${uid}`).delete()
      } catch {
        // Already gone.
      }

      // 5. Delete the Firebase Auth account itself. Do this last so a partial
      //    failure earlier doesn't leave the user unable to recover.
      try {
        await auth.deleteUser(uid)
      } catch {
        // Already deleted or not found.
      }
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

// AK-138 — Trigger E: regimen written → rebuild today's summary so mid-day
// edits to doseAmount / endDate / ongoing propagate to the dashboard
// immediately rather than waiting for the 00:00 IST rebuild cron.
//
// buildTodaySummaryForHousehold writes to `todaySummary/{date}` — it does
// not write to regimens — so there is no write-back loop between this
// trigger and the summary builder. The skip-on-no-op guard below also
// avoids redundant rebuilds when the trigger fires for cosmetic field
// changes (e.g., the createdAt server-stamp being filled in).
export const onRegimenWritten = onDocumentWritten(
  {
    document: 'households/{hId}/treatments/{tId}/regimens/{rId}',
    region: 'asia-south1',
  },
  async (event) => {
    const hId = event.params.hId
    const before = event.data?.before?.data()
    const after = event.data?.after?.data()
    if (!event.data?.before?.exists && !event.data?.after?.exists) return

    // Only rebuild when a field that actually shapes today's slot composition
    // changed. Skips no-op snapshots (e.g., serverTimestamp materialization)
    // and edits to bookkeeping fields like updatedAt.
    const fieldsThatAffectToday = [
      'doseAmount', 'doseUnit', 'scheduleType', 'scheduleDays', 'slots',
      'startDate', 'endDate', 'ongoing', 'cabinetItemId', 'displayName',
    ] as const
    const anyRelevantChange = fieldsThatAffectToday.some(
      (k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
    )
    const docDeletedOrCreated =
      event.data?.before?.exists !== event.data?.after?.exists
    if (!anyRelevantChange && !docDeletedOrCreated) return

    const todayIST = toISTDateString(new Date())
    await buildTodaySummaryForHousehold(hId, todayIST)
  },
)
