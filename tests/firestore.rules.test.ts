// MediCab Firestore Security Rules — automated test harness
//
// Each test maps 1:1 to a row in the manual Rules-Playground table written
// for MC-005. The 22 cases cover every allow/deny path the rules express.
//
// Prerequisite: a Firestore emulator must be reachable on 127.0.0.1:8080.
// Run with the local stack live:
//
//     firebase emulators:start --only firestore   # in one terminal
//     npm run test:rules                          # in another
//
// Or wrap both in a single shot:
//
//     firebase emulators:exec --only firestore "npm run test:rules"

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing'
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  type Firestore,
} from 'firebase/firestore'
import { before, after, beforeEach, describe, it } from 'mocha'

const __dirname = dirname(fileURLToPath(import.meta.url))

let testEnv: RulesTestEnvironment

before(async function () {
  this.timeout(20_000)
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-medicab-rules',
    firestore: {
      rules: readFileSync(join(__dirname, '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

after(async () => {
  if (testEnv) await testEnv.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()
})

// ── Persona helpers ──────────────────────────────────────────────────────────
// `authenticatedContext(uid, claims)` mints an emulator JWT carrying those
// custom claims. The rules read `request.auth.token.hId` / `.role` from
// exactly that token.
const claims = {
  admin:     { hId: 'h1', role: 'admin'     },
  member:    { hId: 'h1', role: 'member'    },
  caregiver: { hId: 'h1', role: 'caregiver' },
} as const

const asPriya     = () => testEnv.authenticatedContext('priya', claims.admin    ).firestore() as unknown as Firestore
const asRajan     = () => testEnv.authenticatedContext('rajan', claims.member   ).firestore() as unknown as Firestore
const asCaregiver = () => testEnv.authenticatedContext('care1', claims.caregiver).firestore() as unknown as Firestore

async function seed(fn: (db: Firestore) => Promise<void>) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx.firestore() as unknown as Firestore)
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Firestore Security Rules', () => {

  describe('users/{uid}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'users/priya'), { uid: 'priya', displayName: 'Priya' })
      })
    })

    it('1. priya can read her own user doc', async () => {
      await assertSucceeds(getDoc(doc(asPriya(), 'users/priya')))
    })

    it('2. priya cannot self-promote by writing role', async () => {
      await assertFails(updateDoc(doc(asPriya(), 'users/priya'), { role: 'caregiver' }))
    })

    it('3. priya can update fcmToken (whitelisted self-service field)', async () => {
      await assertSucceeds(updateDoc(doc(asPriya(), 'users/priya'), { fcmToken: 'abc' }))
    })
  })

  describe('masterDb/{mId}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'masterDb/m1'), { medicineId: 'm1', name: 'Paracetamol' })
      })
    })

    it('4. any signed-in user can read masterDb', async () => {
      await assertSucceeds(getDoc(doc(asPriya(), 'masterDb/m1')))
    })

    it('5. signed-in users cannot write masterDb', async () => {
      await assertFails(updateDoc(doc(asPriya(), 'masterDb/m1'), { name: 'Hacked' }))
    })
  })

  describe('households/{hId}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'households/h1'), { hId: 'h1', name: 'Sharma' })
      })
    })

    it('6. rajan (member) can read his household', async () => {
      await assertSucceeds(getDoc(doc(asRajan(), 'households/h1')))
    })

    it('7. rajan (member) cannot update the household', async () => {
      await assertFails(updateDoc(doc(asRajan(), 'households/h1'), { name: 'Hacked' }))
    })
  })

  describe('households/{hId}/cabinets/{cId}/items/{iId}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'households/h1/cabinets/c1/items/i1'), {
          iId: 'i1',
          name: 'Metformin',
          quantityOnHand: 30,
          updatedAt: 0,
        })
      })
    })

    it('8. priya (admin) can update any field on an item', async () => {
      await assertSucceeds(updateDoc(doc(asPriya(), 'households/h1/cabinets/c1/items/i1'), {
        name: 'Metformin 500',
        quantityOnHand: 28,
      }))
    })

    it('9. rajan (member) can update quantityOnHand + updatedAt (dose log)', async () => {
      await assertSucceeds(updateDoc(doc(asRajan(), 'households/h1/cabinets/c1/items/i1'), {
        quantityOnHand: 29,
        updatedAt: 1,
      }))
    })

    it('10. rajan (member) cannot update other fields', async () => {
      await assertFails(updateDoc(doc(asRajan(), 'households/h1/cabinets/c1/items/i1'), {
        name: 'Hack',
      }))
    })
  })

  describe('households/{hId}/treatments/{tId}/logs/{slotId}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'households/h1/treatments/t1'), { tId: 't1', name: 'Daily' })
        await setDoc(doc(db, 'households/h1/treatments/t1/logs/seedLog'), {
          slotId: 'seedLog',
          patientId: 'rajan',
          status: 'taken',
        })
      })
    })

    it('11. rajan (member) can create a log for himself', async () => {
      await assertSucceeds(setDoc(doc(asRajan(), 'households/h1/treatments/t1/logs/r1'), {
        slotId: 'r1',
        patientId: 'rajan',
        status: 'taken',
      }))
    })

    it('12. rajan (member) cannot create a log for someone else', async () => {
      await assertFails(setDoc(doc(asRajan(), 'households/h1/treatments/t1/logs/r2'), {
        slotId: 'r2',
        patientId: 'priya',
        status: 'taken',
      }))
    })

    it('13. nobody can delete a dose log (immutable history)', async () => {
      await assertFails(deleteDoc(doc(asPriya(), 'households/h1/treatments/t1/logs/seedLog')))
    })
  })

  describe('households/{hId}/todaySummary/{date}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'households/h1/todaySummary/2026-05-03'), {
          date: '2026-05-03',
          taken: 0,
        })
        await setDoc(doc(db, 'households/h1/cabinets/c1'), { cId: 'c1', name: 'Main' })
      })
    })

    it('14. rajan (member) can read todaySummary', async () => {
      await assertSucceeds(getDoc(doc(asRajan(), 'households/h1/todaySummary/2026-05-03')))
    })

    it('15. caregiver can read todaySummary', async () => {
      await assertSucceeds(getDoc(doc(asCaregiver(), 'households/h1/todaySummary/2026-05-03')))
    })

    it('16. caregiver cannot read /cabinets', async () => {
      await assertFails(getDoc(doc(asCaregiver(), 'households/h1/cabinets/c1')))
    })
  })

  describe('households/{hId}/inventoryAudits/{auditId}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'households/h1/inventoryAudits/a1'), {
          auditId: 'a1',
          count: 30,
        })
      })
    })

    it('17. admin cannot update an audit (immutable ledger)', async () => {
      await assertFails(updateDoc(doc(asPriya(), 'households/h1/inventoryAudits/a1'), {
        updatedAt: 1,
      }))
    })
  })

  describe('households/{hId}/inventoryConflicts/{conflictId}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'households/h1/inventoryConflicts/c1'), {
          conflictId: 'c1',
          status: 'open',
        })
      })
    })

    it('18. admin can dismiss a conflict (status, dismissedBy, dismissedAt only)', async () => {
      await assertSucceeds(updateDoc(doc(asPriya(), 'households/h1/inventoryConflicts/c1'), {
        status: 'dismissed',
        dismissedBy: 'priya',
        dismissedAt: 1,
      }))
    })

    it('19. admin cannot edit any other field on a conflict', async () => {
      await assertFails(updateDoc(doc(asPriya(), 'households/h1/inventoryConflicts/c1'), {
        status: 'dismissed',
        note: 'free text',
      }))
    })
  })

  describe('consentLog/{uid} (MC-017a)', () => {
    it('23. priya can create her own consent record', async () => {
      await assertSucceeds(setDoc(doc(asPriya(), 'consentLog/priya'), {
        uid: 'priya',
        policyVersion: '2026-05-06',
        appVersion: 'dev',
        platform: 'web',
      }))
    })

    it('24. priya cannot create a consent record for another uid', async () => {
      await assertFails(setDoc(doc(asPriya(), 'consentLog/rajan'), {
        uid: 'rajan',
        policyVersion: '2026-05-06',
        appVersion: 'dev',
        platform: 'web',
      }))
    })

    it('25. priya cannot update or delete her own consent record', async () => {
      await seed(async db => {
        await setDoc(doc(db, 'consentLog/priya'), {
          uid: 'priya',
          policyVersion: '2026-05-06',
          appVersion: 'dev',
          platform: 'web',
        })
      })
      await assertFails(updateDoc(doc(asPriya(), 'consentLog/priya'), {
        policyVersion: '2099-01-01',
      }))
      await assertFails(deleteDoc(doc(asPriya(), 'consentLog/priya')))
    })

    it('26. consentLog records survive account deletion (anonymised, not removed)', async () => {
      // Simulate post-purge state: the user's profile, household membership,
      // and aiLogs are gone, but the consent record remains as an immutable
      // historical artefact. The owner can still read it.
      await seed(async db => {
        await setDoc(doc(db, 'consentLog/priya'), {
          uid: 'priya',
          policyVersion: '2026-05-06',
          appVersion: 'dev',
          platform: 'web',
        })
      })
      await assertSucceeds(getDoc(doc(asPriya(), 'consentLog/priya')))
      // And it still cannot be wiped, even after the rest of the user's data
      // has been purged by the daily cron.
      await assertFails(deleteDoc(doc(asPriya(), 'consentLog/priya')))
    })
  })

  describe('aiLogs/{uid}/queries/{id}', () => {
    beforeEach(async () => {
      await seed(async db => {
        await setDoc(doc(db, 'aiLogs/priya/queries/q1'), { id: 'q1' })
      })
    })

    it("20. another user cannot read priya's ai log", async () => {
      await assertFails(getDoc(doc(asRajan(), 'aiLogs/priya/queries/q1')))
    })

    it('21. priya can read her own ai log', async () => {
      await assertSucceeds(getDoc(doc(asPriya(), 'aiLogs/priya/queries/q1')))
    })

    it('22. priya cannot create an ai log (Cloud-Function-only)', async () => {
      await assertFails(setDoc(doc(asPriya(), 'aiLogs/priya/queries/q2'), { id: 'q2' }))
    })
  })

})
