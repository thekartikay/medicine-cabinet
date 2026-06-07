// AK-195 — Reimagined Firestore-backed context.
//
// A PARALLEL data layer for the Reimagined shell only — it does not touch the
// existing App context or its data flow. It opens real-time listeners on the
// household's members, treatments, cabinet items, and (per treatment) regimens
// + today's dose logs, projects the raw docs through trackedMedicine.ts into
// TrackedMedicine[] grouped by person, and exposes three actions that delegate
// to the EXISTING firestoreService functions (no new write paths):
//   • markDose      → logDose (the rule-bound dose-log + inventory transaction)
//   • addTracked    → createTreatment + addRegimen
//   • requestRestock→ createRestockRequest
//
// Pure data-shaping (projection/grouping, slot index, restock args) lives in
// ./reimaginedProjection so this module exports only the provider + hook.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '../lib/firebase'
import { getDefaultCabinetId, todayISTString } from '../lib/paths'
import {
  addRegimen,
  createRestockRequest,
  createTreatment,
  getUserDoc,
  logDose,
  subscribeCabinetItems,
  subscribeHouseholdMembers,
  subscribeRegimens,
  subscribeTodayLogs,
  subscribeTreatments,
} from '../services/firestoreService'
import {
  buildSlotIndex,
  buildTrackedByPerson,
  resolveRestockArgs,
  type AddTrackedInput,
} from './reimaginedProjection'
import { ReimaginedContext, type ReimaginedCtxValue } from './reimaginedContext'
import type { CabinetItem, DoseLog, DoseStatus, HouseholdMember, Regimen, Treatment } from '../types'

export function ReimaginedProvider({ children }: { children: ReactNode }) {
  const [uid, setUid] = useState<string | null>(null)
  const [hId, setHId] = useState<string | null>(null)
  const [authResolved, setAuthResolved] = useState(false)

  const [members, setMembers] = useState<HouseholdMember[]>([])
  const [treatments, setTreatments] = useState<Treatment[]>([])
  const [items, setItems] = useState<CabinetItem[]>([])
  const [regimensByTreatment, setRegimensByTreatment] = useState<Record<string, Regimen[]>>({})
  const [logsByTreatment, setLogsByTreatment] = useState<Record<string, DoseLog[]>>({})

  const [membersLoaded, setMembersLoaded] = useState(false)
  const [treatmentsLoaded, setTreatmentsLoaded] = useState(false)
  const [itemsLoaded, setItemsLoaded] = useState(false)

  // The IST day is fixed for the session; the log listeners + projection all
  // key off it. (A session spanning midnight keeps yesterday's day — acceptable
  // for this preview.)
  const [today] = useState(() => todayISTString())

  // Per-treatment regimen + log unsubscribers, reconciled as treatments change.
  const perTreatmentUnsubs = useRef<Map<string, () => void>>(new Map())

  // Resolve uid + hId from the current Firebase auth session. hId comes from the
  // user doc's householdId (the same source App.tsx uses), so this works without
  // re-running App's auth/consent pipeline. All setState here is inside the
  // async auth/getUserDoc callbacks, not the synchronous effect body.
  useEffect(() => {
    let cancelled = false
    const unsub = onAuthStateChanged(auth, (u) => {
      if (cancelled) return
      if (!u) {
        setUid(null)
        setHId(null)
        setAuthResolved(true)
        return
      }
      setUid(u.uid)
      getUserDoc(u.uid)
        .then((appUser) => {
          if (cancelled) return
          setHId(appUser?.householdId ?? null)
          setAuthResolved(true)
        })
        .catch(() => {
          if (cancelled) return
          setHId(null)
          setAuthResolved(true)
        })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Top-level collection listeners. setState happens only inside the async
  // onSnapshot callbacks; the effect body just (un)subscribes.
  useEffect(() => {
    if (!hId) return
    const cId = getDefaultCabinetId(hId)
    const unsubMembers = subscribeHouseholdMembers(hId, (m) => {
      setMembers(m)
      setMembersLoaded(true)
    })
    const unsubTreatments = subscribeTreatments(hId, (t) => {
      setTreatments(t)
      setTreatmentsLoaded(true)
    })
    const unsubItems = subscribeCabinetItems(hId, cId, (i) => {
      setItems(i)
      setItemsLoaded(true)
    })
    return () => {
      unsubMembers()
      unsubTreatments()
      unsubItems()
    }
  }, [hId])

  // Reconcile per-treatment regimen + today-log listeners against the current
  // treatment id set. Re-runs only when the set of ids (or hId/today) changes.
  // setState happens only inside the async onSnapshot callbacks. Stale cache
  // entries for removed treatments are left in place — buildTrackedByPerson only
  // reads entries for the current `treatments`, so they are inert.
  const tIdsKey = useMemo(() => treatments.map((t) => t.tId).sort().join(','), [treatments])
  useEffect(() => {
    const map = perTreatmentUnsubs.current
    if (!hId) {
      for (const [, unsub] of map) unsub()
      map.clear()
      return
    }
    const desired = new Set(tIdsKey ? tIdsKey.split(',') : [])
    for (const tId of desired) {
      if (map.has(tId)) continue
      const unsubReg = subscribeRegimens(hId, tId, (regs) =>
        setRegimensByTreatment((prev) => ({ ...prev, [tId]: regs })),
      )
      const unsubLog = subscribeTodayLogs(hId, tId, today, (logs) =>
        setLogsByTreatment((prev) => ({ ...prev, [tId]: logs })),
      )
      map.set(tId, () => {
        unsubReg()
        unsubLog()
      })
    }
    for (const [tId, unsub] of map) {
      if (desired.has(tId)) continue
      unsub()
      map.delete(tId)
    }
  }, [hId, today, tIdsKey])

  // Tear down every per-treatment listener on unmount.
  useEffect(() => {
    const map = perTreatmentUnsubs.current
    return () => {
      for (const [, unsub] of map) unsub()
      map.clear()
    }
  }, [])

  const trackedByPerson = useMemo(
    () =>
      hId ? buildTrackedByPerson(treatments, regimensByTreatment, logsByTreatment, items, today) : {},
    [hId, treatments, regimensByTreatment, logsByTreatment, items, today],
  )

  const slotIndex = useMemo(
    () => buildSlotIndex(treatments, regimensByTreatment, today),
    [treatments, regimensByTreatment, today],
  )

  // isLoading: true until auth resolves and every initial snapshot has fired.
  // When there's no household, there's nothing to load.
  const allTreatmentsHydrated = useMemo(
    () =>
      treatments.every(
        (t) =>
          Object.prototype.hasOwnProperty.call(regimensByTreatment, t.tId) &&
          Object.prototype.hasOwnProperty.call(logsByTreatment, t.tId),
      ),
    [treatments, regimensByTreatment, logsByTreatment],
  )
  const isLoading = !authResolved
    ? true
    : hId
      ? !(membersLoaded && treatmentsLoaded && itemsLoaded && allTreatmentsHydrated)
      : false

  const markDose = useCallback(
    async (slotId: string, status: DoseStatus = 'taken') => {
      if (!hId || !uid) throw new Error('markDose: no active household/user')
      const args = slotIndex.get(slotId)
      if (!args) throw new Error(`markDose: unknown slot ${slotId}`)
      await logDose(hId, { ...args, status, createdBy: uid })
    },
    [hId, uid, slotIndex],
  )

  const addTracked = useCallback(
    async (data: AddTrackedInput) => {
      if (!hId) throw new Error('addTracked: no active household')
      const tId = await createTreatment(hId, data.treatment)
      await addRegimen(hId, tId, data.regimen)
      return tId
    },
    [hId],
  )

  const requestRestock = useCallback(
    async (itemId: string) => {
      if (!hId || !uid) throw new Error('requestRestock: no active household/user')
      const args = resolveRestockArgs(items, itemId, uid)
      if (!args) throw new Error(`requestRestock: unknown item ${itemId}`)
      await createRestockRequest(hId, args)
    },
    [hId, uid, items],
  )

  const value = useMemo<ReimaginedCtxValue>(
    () => ({
      isLoading,
      members: hId ? members : [],
      trackedByPerson,
      markDose,
      addTracked,
      requestRestock,
    }),
    [isLoading, hId, members, trackedByPerson, markDose, addTracked, requestRestock],
  )

  return <ReimaginedContext.Provider value={value}>{children}</ReimaginedContext.Provider>
}
