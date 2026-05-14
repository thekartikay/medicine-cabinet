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

// MC-013 — a medicine the user is about to add to the cabinet (no iId yet
// because no Firestore doc exists). The proxy synthesises a fake
// CabinetContextItem from these fields so the model can check whether the
// pending addition would interact with anything already in the cabinet.
// Optional fields are passed through when known; the model only really needs
// brandName + activeIngredients to identify what the medicine actually is.
export interface CandidateMedicine {
  medicineId: string                  // masterDb id when the user picked from search
  brandName: string                   // user-facing name, always present
  activeIngredients?: string[]        // each entry contributes to the hallucination name index
  dosageForm?: string                 // 'tablet' | 'syrup' | …
  strength?: string                   // '500mg', '2.5mg/ml', …
}

export interface DrugInteractionRequest {
  queryType: 'drug_interaction'
  hId: string
  cId: string
  // Cabinet item IDs (not medicineIds): the proxy resolves each to the
  // underlying medicineId via households/{hId}/cabinets/{cId}/items/{iId}
  // before consulting masterDb. Keeps the client out of masterDb lookups.
  cabinetItemIds: string[]
  // MC-013 — optional. When present, the proxy includes a synthetic item
  // representing this medicine in the model context, so the check answers
  // "would adding X interact with what's already in the cabinet?" rather
  // than just "do the existing items interact with each other?"
  // Backward-compatible: omitting this field reproduces the original
  // (cabinet-only) behaviour exactly.
  candidateMedicine?: CandidateMedicine
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
  // AK-39 — Structured interaction signal from the model. Drug-interaction
  // success responses set this; cabinet_query leaves it undefined. Treated
  // as "no interaction confirmed" when absent, so consumers default-safe.
  interactionFlag?: {
    hasInteraction: boolean
    riskLevel: 'moderate' | 'high' | null
  } | null
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
