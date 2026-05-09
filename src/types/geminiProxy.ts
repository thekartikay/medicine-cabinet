// Mirror of functions/src/types/geminiProxy.ts.
// These two files MUST stay in sync. Update both when changing
// request/response shapes.

// ── Requests ─────────────────────────────────────────────────────────────

export interface CabinetQueryRequest {
  queryType: 'cabinet_query'
  hId: string
  cId: string
  query: string
}

export interface DrugInteractionRequest {
  queryType: 'drug_interaction'
  hId: string
  cId: string
  // Cabinet item IDs (not medicineIds): the proxy resolves each to the
  // underlying medicineId via households/{hId}/cabinets/{cId}/items/{iId}
  // before consulting masterDb. Keeps the client out of masterDb lookups.
  cabinetItemIds: string[]
}

export type GeminiProxyRequest = CabinetQueryRequest | DrugInteractionRequest

// ── Responses ────────────────────────────────────────────────────────────

export type RefusalType =
  | 'DIAGNOSTIC_REFUSAL'
  | 'EMERGENCY_REFUSAL'
  | 'LOW_CONFIDENCE_REFUSAL'

// Layer 6 post-checks turn 'low' confidence into LOW_CONFIDENCE_REFUSAL,
// so 'answer' responses can never carry 'low'.
export type AnswerConfidence = 'high' | 'medium'

export interface AnswerResponse {
  kind: 'answer'
  text: string
  confidence: AnswerConfidence
  medicinesReferenced: string[]
  // Populated only for drug_interaction responses; undefined for cabinet_query.
  sources?: string[]
}

export interface RefusalResponse {
  kind: 'refusal'
  refusalType: RefusalType
  message: string
}

// Free-tier daily quota was exceeded for cabinet_query. Never returned for
// drug_interaction — that path is rate-limit-exempt per CLAUDE.md rule 6.
export interface RateLimitedResponse {
  kind: 'rate_limited'
  message: string
}

// Machine-readable code is carried on the `message` field. Examples:
// 'hallucination_detected', 'parse_failure', 'gemini_api_error'.
export interface ErrorResponse {
  kind: 'error'
  message: string
}

export type GeminiProxyResponse =
  | AnswerResponse
  | RefusalResponse
  | RateLimitedResponse
  | ErrorResponse
