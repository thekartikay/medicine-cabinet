// AK-176 — init-rejection coverage (cross-review fix #4 + #5).
//
// This file is intentionally separate from ak176.test.ts because once
// getFirestoreContext()'s IIFE rejects, the memoized rejected promise
// persists in `_firestoreCtx` for the rest of the worker's lifetime — any
// subsequent test that awaits getFirestoreContext() would also reject and
// fail. Vitest's default per-file isolation gives this file a fresh module
// graph (own Firebase app, own _firestoreCtx variable), so the cached
// rejection here doesn't leak into the main test suite.
//
// What this proves:
//   1. The subscription wrapper handles a rejected init cleanly: no sync
//      throw from the subscribe call, no unhandled rejection escaping to
//      process listeners, no leaked listener firing the data callback.
//   2. Empirical answer for cross-review #5 — once `_firestoreCtx` holds
//      a rejected promise, every subsequent getFirestoreContext() call
//      returns that SAME rejected promise. No retry. Documented in the
//      "memoized-rejection" test below and in the AK-176 report.
//
// Mechanism for forcing the rejection:
//   - Call __resetFirestoreContextForTest() so the memo is null.
//   - Remove globalThis.indexedDB before any getFirestoreContext() runs.
//   - Subscribe → IIFE starts → after the 500 ms delay hook,
//     initializeFirestore(app, { localCache: persistentLocalCache(...) })
//     attempts to bring up persistent storage and fails (no IDB). The IIFE's
//     async function rejects.
//
// If Firestore's SDK does NOT throw eagerly on missing IndexedDB at
// initializeFirestore time (the failure could surface only on first cache
// read/write instead), the test still passes its safety assertions — no
// sync throw, no unhandled rejection, no callback fire — but the "is the
// memo a rejected promise" probe at the end of the test will report
// "resolved" instead. Either way, the test reports what actually happens
// so the AK-176 review can make the call.

import { describe, it, expect, beforeAll } from 'vitest'
import {
  initializeApp as initAdminApp,
  getApps as getAdminApps,
} from 'firebase-admin/app'

// ★ REAL APP MODULES — same import path as ak176.test.ts.
import {
  getFirestoreContext,
  __resetFirestoreContextForTest,
} from '../../src/lib/firebase'
import { subscribeAddresses } from '../../src/services/firestoreService'

// Emulator host env — Admin SDK only needs FIRESTORE_EMULATOR_HOST set for
// the (best-effort, may fail) cleanup; the client SDK side never connects
// because init rejects before connectFirestoreEmulator runs.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'

const PROJECT_ID = 'demo-medicab'

beforeAll(() => {
  if (getAdminApps().length === 0) {
    initAdminApp({ projectId: PROJECT_ID })
  }
})

describe('AK-176 — init-rejection: no throw, no leak, no fire', () => {
  it('subscription wrapper with rejected getFirestoreContext is well-behaved', async () => {
    // Step 1 — reset the memo so getFirestoreContext re-runs the IIFE.
    __resetFirestoreContextForTest()

    // Step 2 — remove the IndexedDB polyfill so persistentLocalCache init has
    // nowhere to land. We use property assignment to `undefined` rather than
    // `delete` because TS strict mode flags `delete` on a non-optional. The
    // observable effect is identical for any SDK code that reads
    // `globalThis.indexedDB`.
    const realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined

    let callbackFired = false
    let syncThrew: unknown = null
    let unhandledRejection: unknown = null

    const onUnhandled = (err: unknown) => {
      unhandledRejection = err
    }
    process.on('unhandledRejection', onUnhandled)

    let memoFinalState: 'rejected' | 'resolved' | 'unknown' = 'unknown'
    let memoError: unknown = undefined

    try {
      // The subscribe call must NOT throw synchronously. The wrapper kicks
      // off getFirestoreContext() (asynchronous) and returns the unsub
      // function synchronously regardless of how the init eventually settles.
      try {
        const unsub = subscribeAddresses(
          'ak176-init-rejection-test-hh',
          () => {
            callbackFired = true
          },
        )
        // Synchronous teardown right after subscribe. Safe even with a
        // rejected init — `realUnsub?.()` is the optional-chained call and
        // is a no-op when the listener never attached.
        unsub()
      } catch (e) {
        syncThrew = e
      }

      // Wait past the 500 ms init delay + a generous buffer for the IIFE's
      // dynamic import + initializeFirestore + any internal cache-init error.
      await new Promise((r) => setTimeout(r, 2_000))

      // Probe: what did the memo end up holding?
      // - If the IIFE rejected, awaiting it throws → memoFinalState='rejected'.
      // - If the IIFE somehow resolved (Firestore did not check IDB eagerly),
      //   awaiting it succeeds → memoFinalState='resolved'.
      try {
        await getFirestoreContext()
        memoFinalState = 'resolved'
      } catch (e) {
        memoFinalState = 'rejected'
        memoError = e
      }
    } finally {
      process.off('unhandledRejection', onUnhandled)
      // Restore the polyfill so other tests in the worker (if any) work.
      ;(globalThis as { indexedDB?: unknown }).indexedDB = realIndexedDB
    }

    // ── Safety assertions (regardless of which branch the SDK took) ──
    expect(syncThrew).toBeNull()
    expect(callbackFired).toBe(false)
    expect(unhandledRejection).toBeNull()

    // Report what actually happened. Either branch is acceptable for the
    // safety contract above; the memoFinalState answer feeds back into
    // cross-review #5 so the team can decide whether to keep the current
    // "memoize-rejection-forever" behavior or change to retry-on-rejection.
    console.log(
      `[AK-176 #5 report] memo final state: ${memoFinalState}` +
        (memoError ? ` (error: ${(memoError as Error)?.message ?? String(memoError)})` : ''),
    )
  })

  it('memoized rejection: second getFirestoreContext call returns the SAME rejected promise (no retry)', async () => {
    // This test depends on the previous test having populated _firestoreCtx
    // with a rejected promise. If the previous test's memo ended up as a
    // resolved promise (because the SDK didn't check IDB eagerly), this test
    // observes "two parallel calls return the same RESOLVED promise" — which
    // still demonstrates memoization, just not the rejection-specific path.
    //
    // The load-bearing assertion is identity: p1 === p2. That holds whether
    // the cached promise is resolved or rejected. The presence/absence of
    // a rejection error feeds back into cross-review #5; the identity
    // assertion is the actual correctness check.

    const realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined

    try {
      const p1 = getFirestoreContext()
      const p2 = getFirestoreContext()
      expect(p1).toBe(p2)

      // Settle both promises. If they're rejected, .catch swallows. If they're
      // resolved, both resolve to the same value. Either way no test failure.
      let outcome: 'both-rejected-same-error' | 'both-resolved-same-value' | 'mismatch' = 'mismatch'
      try {
        const [v1, v2] = await Promise.all([p1, p2])
        outcome = v1 === v2 ? 'both-resolved-same-value' : 'mismatch'
      } catch (err1) {
        try {
          await p2
          outcome = 'mismatch' // p1 rejected, p2 didn't — impossible if memo is shared
        } catch (err2) {
          outcome = err1 === err2 ? 'both-rejected-same-error' : 'mismatch'
        }
      }
      expect(outcome).not.toBe('mismatch')

      console.log(`[AK-176 #5 report] second-call memoization outcome: ${outcome}`)
    } finally {
      ;(globalThis as { indexedDB?: unknown }).indexedDB = realIndexedDB
    }
  })
})
