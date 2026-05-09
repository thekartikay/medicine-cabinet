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
  DrugInteractionRequest,
  GeminiProxyRequest,
  GeminiProxyResponse,
} from '../types/geminiProxy'

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

// Drug-interaction check across two or more cabinet items. Never rate-
// limited (CLAUDE.md rule 6); the proxy hard-rejects responses that
// reference medicines outside the supplied subset.
export async function checkDrugInteraction(
  cabinetItemIds: string[],
  hId: string,
  cId: string,
): Promise<GeminiProxyResponse> {
  const req: DrugInteractionRequest = {
    queryType: 'drug_interaction',
    hId,
    cId,
    cabinetItemIds,
  }
  return callProxy('checkDrugInteraction', req)
}
