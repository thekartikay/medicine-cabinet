// Client wrapper for the geminiProxy Cloud Function (MC-004).
//
// The function is deployed in asia-south1 and enforced by App Check, so
// callers must already be authenticated and the App Check token must have
// been minted (see src/lib/firebase.ts). Everything that used to live on
// the client — the API key, the system prompt, the rate limiter, the
// emergency/diagnostic regex layers — now lives in functions/src/geminiProxy.ts.
// This file just carries a typed httpsCallable and folds error paths into
// the same discriminated response shape so callers have one switch to handle.
//
// Per CLAUDE.md rule 2: no Gemini API calls from the client. This module
// only ever invokes the proxy.

import { httpsCallable, type HttpsCallableResult } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from '../lib/firebase'
import type {
  CabinetQueryRequest,
  CandidateMedicine,
  DrugInteractionRequest,
  GeminiProxyRequest,
  GeminiProxyResponse,
} from '../types/geminiProxy'
import type { CabinetItem } from '../types'

// Single shared callable handle. `functions` is already pinned to
// asia-south1 by lib/firebase.ts, so the call lands at the proxy without
// per-call configuration.
const proxy = httpsCallable<GeminiProxyRequest, GeminiProxyResponse>(
  functions,
  'geminiProxy',
)

// Wraps the callable in a try/catch that converts thrown HttpsError /
// network errors into a synthetic { kind: 'error' } so the caller has a
// single response shape to switch on. The function name is logged in dev
// to help track down which call surfaced the error.
async function callProxy(
  source: string,
  payload: GeminiProxyRequest,
): Promise<GeminiProxyResponse> {
  try {
    const result: HttpsCallableResult<GeminiProxyResponse> = await proxy(payload)
    return result.data
  } catch (err: unknown) {
    if (err instanceof FirebaseError) {
      // FirebaseError covers HttpsError ('unauthenticated', 'permission-denied',
      // 'invalid-argument', 'failed-precondition', etc.) emitted server-side
      // and any client-side functions/* error code (e.g. functions/internal,
      // functions/unavailable). The Firebase code is the most useful machine-
      // readable bit; surface that on `message`.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.error(`[geminiService] ${source} failed:`, err.code, err.message)
      }
      return { kind: 'error', message: err.code }
    }
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error(`[geminiService] ${source} failed (network):`, err)
    }
    return { kind: 'error', message: 'network_error' }
  }
}

// Natural-language question about the user's cabinet. Subject to the proxy's
// pre-model emergency keyword check, diagnostic blocklist, and Free-tier
// daily rate limit. Returns one of: answer, refusal, rate_limited, error.
export async function askCabinet(
  query: string,
  hId: string,
  cId: string,
): Promise<GeminiProxyResponse> {
  const req: CabinetQueryRequest = {
    queryType: 'cabinet_query',
    hId,
    cId,
    query,
  }
  return callProxy('askCabinet', req)
}

// Drug-interaction check. Never rate-limited (CLAUDE.md rule 6); the proxy
// hard-rejects responses that reference medicines outside the supplied
// subset.
//
// Two call shapes:
//   • Existing-cabinet check — pass at least 2 cabinetItemIds; omit
//     candidateMedicine. Backward-compat with the AK-31 eval set.
//   • Pending-addition check (MC-013) — pass 1+ cabinetItemIds and a
//     candidateMedicine describing the medicine the user is about to add.
//     The proxy synthesises a "would adding X interact with the rest?"
//     prompt and returns the same discriminated response shape.
export async function checkDrugInteraction(
  cabinetItemIds: string[],
  hId: string,
  cId: string,
  candidateMedicine?: CandidateMedicine,
): Promise<GeminiProxyResponse> {
  const req: DrugInteractionRequest = {
    queryType: 'drug_interaction',
    hId,
    cId,
    cabinetItemIds,
    ...(candidateMedicine ? { candidateMedicine } : {}),
  }
  return callProxy('checkDrugInteraction', req)
}

// AK-39 — Passive interaction check fired after a cabinet add succeeds.
// Builds a CandidateMedicine payload from the freshly added item and passes
// the iIds of everything else already in the cabinet as the comparison set.
// The proxy is exempt from the daily rate limit for drug_interaction
// (CLAUDE.md rule #6).
//
// Returns null on:
//   • empty otherItems (nothing to interact with)
//   • proxy refusal / error / rate_limited
//   • proxy answer where the model flagged hasInteraction=false (or didn't
//     supply the structured field — treated as no interaction, safe default)
//
// Returns the structured warning when the model's interactionFlag confirms
// a known interaction. Reads the proxy's structured response directly — the
// heuristic prose parser that lived here previously is gone (sub-task: move
// hasInteraction/riskLevel from client regex to server JSON schema).
//
// Callers should fire-and-forget for the passive cabinet-add case; the
// treatment-create gate (AK-39 sub-task 2) awaits the result to drive a
// confirm modal but tolerates rejection / errors as no-warning.
export async function checkCabinetInteractions(
  newItem: CabinetItem,
  otherCabinetItemIds: string[],
): Promise<{
  hasInteraction: boolean
  riskLevel: 'moderate' | 'high'
  withMedicineNames: string[]
  description: string
} | null> {
  if (otherCabinetItemIds.length === 0) return null

  const candidate = candidateMedicineFromItem(newItem)
  const response = await checkDrugInteraction(
    otherCabinetItemIds,
    newItem.hId,
    newItem.cId,
    candidate,
  )

  if (response.kind !== 'answer') return null

  const flag = response.interactionFlag
  if (!flag?.hasInteraction) return null

  const candidateName =
    newItem.displayNameOverride ?? newItem.brandName ?? newItem.medicineId
  const withMedicineNames = (response.sources ?? []).filter(
    (name) => name.toLowerCase() !== candidateName.toLowerCase(),
  )
  if (withMedicineNames.length === 0) return null

  const description =
    response.text.split(/(?<=[.!?])\s+/)[0]?.trim().slice(0, 200) ?? ''

  return {
    hasInteraction: true,
    riskLevel: flag.riskLevel === 'high' ? 'high' : 'moderate',
    withMedicineNames,
    description,
  }
}

function candidateMedicineFromItem(item: CabinetItem): CandidateMedicine {
  const ai = (item.activeIngredients ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const brandName =
    item.displayNameOverride ?? item.brandName ?? item.medicineId
  return {
    medicineId: item.medicineId,
    brandName,
    ...(ai.length > 0 ? { activeIngredients: ai } : {}),
    ...(item.dosageForm ? { dosageForm: item.dosageForm } : {}),
    ...(item.strength ? { strength: item.strength } : {}),
  }
}
