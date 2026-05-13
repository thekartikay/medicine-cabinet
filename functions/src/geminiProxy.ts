// MC-004 — Gemini API proxy.
//
// Single onCall callable that handles every AI query MediCab routes through
// Gemini, in seven layers (matching the spec's numbering, not execution
// order — sequence below is fail-fast):
//
//   L5. Emergency keyword detection           pre-model, cabinet_query only
//   L4. Diagnostic blocklist                  pre-model, cabinet_query only
//   ── Rate limit                             cabinet_query only, free tier
//   L1. System prompt                         injected
//   L2. Inventory injection                   structured cabinet context
//   L6. Structured JSON output                Gemini call + parse + validate
//   L3. Output validation                     hallucination check
//   L7. Audit log                             every code path before return
//
// New queryTypes (e.g. image-based queries for MC-012) extend the
// discriminated request union and add a switch case here — never a new
// callable. Single audit pipeline, single rate-limit policy, single key.

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { GoogleGenAI } from '@google/genai'
import { todayISTDateString } from './util/istDate'
import { ENFORCE_APP_CHECK } from './util/enforceAppCheck'
import type {
  CandidateMedicine,
  GeminiProxyRequest,
  GeminiProxyResponse,
  RefusalType,
} from './types/geminiProxy'

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY')
const MODEL = 'gemini-2.5-flash'
const FREE_TIER_DAILY_LIMIT = 3

// ─── Layer 5 — emergency keyword patterns ──────────────────────────────────
// Pre-model gate for cabinet_query. Any match → EMERGENCY_REFUSAL with no
// Gemini call. Reviewable list — extend cautiously (false positives become
// frustrating refusals; misses are dangerous). Whole-word / phrase matches
// only, case-insensitive.
//
// TODO(future-ticket): Regex coverage for emergency keywords is
// necessarily incomplete. A panicked user typing "ovrdose" or
// "chst pain" will currently miss the regex and route to Gemini,
// adding ~3-5 seconds to the response time. The Layer 6 model
// self-flagging (is_emergency) catches these correctly so the
// user still gets EMERGENCY_REFUSAL — just slowly.
//
// Future improvement: add Levenshtein-distance matching against
// a high-priority emergency token list, OR a Level-4 always-route
// strategy where any query within 2 edits of an emergency word is
// refused without calling Gemini at all. The trade-off is more
// false positives ("I read about overdoses online" gets refused)
// vs. faster legitimate emergency response.
//
// Track as a follow-up ticket; not blocking AK-31 close.
const EMERGENCY_PATTERNS: RegExp[] = [
  /\bchest pain\b/i,
  // Catches "can't breathe", "cant breath", "cn't breathing" — covers
  // missing apostrophes, ESL phrasing, and the breath/breathe/breathing
  // verb-tense spread. Replaces the narrower /\bcan'?t breathe\b/i.
  /\bca?n.?t (breath|breathe|breathing)\b/i,
  // Collapse / unconscious-with-no-breathing scenario.
  /\bnot breathing\b/i,
  /\bbreathing trouble\b/i,
  /\bstroke\b/i,
  // overdose / overdosed / overdosing / over-dose / over dose / overdoser.
  // Replaces narrower /\boverdos(?:e|ed|ing)\b/i to cover hyphenated and
  // space-separated forms users type under stress.
  /\bover[\s-]?dos(e|ed|ing|er)\b/i,
  // swallow / swallowed / swallowing + "swalow"/"swalowed" (common one-L
  // typo). Replaces narrower /\bswallowed\b/i. Subsumes the previous
  // /\bcan'?t swallow\b/i since any "swallow" substring now matches.
  /\bswall?ow(ed|ing)?\b/i,
  /\bpoisoned\b/i,
  // unconscious / unresponsive / won't wake up / wont respond.
  // Replaces narrower /\bunconscious\b/i.
  /\bunconscious|unresponsive|wo[nu].?t (wake up|respond)\b/i,
  /\bfaint(?:ed|ing)?\b/i,
  /\bsevere allergic\b/i,
  /\banaphylaxis\b/i,
  /\bthroat closing\b/i,
  /\bblue lips\b/i,
  /\bblue fingers\b/i,
  // Cyanosis indicator phrased as colour change ("turning blue").
  /\bturn(ing|ed)? blue\b/i,
  // seizure / seized / seizing / seizes. Replaces narrower /\bseizure\b/i.
  /\bseiz(ure|ed|ing|es)\b/i,
  /\bconvulsion\b/i,
  // choke / choked / choking — separate from the swallow family.
  /\bchok(e|ed|ing)\b/i,
  /\bbleeding heavily\b/i,
  /\bwon'?t stop bleeding\b/i,
]

// ─── Layer 4 — diagnostic blocklist ────────────────────────────────────────
// Pre-model gate for cabinet_query. Match → DIAGNOSTIC_REFUSAL, no Gemini
// call. Aimed at "what should I take" / "what's wrong with me" / dosing-
// adjustment questions where the safe answer is always "see a doctor".
const DIAGNOSTIC_PATTERNS: RegExp[] = [
  /\bwhat (should|can) I take\b/i,
  /\bwhat to take\b/i,
  /\bwhich (medicine|drug|pill) should\b/i,
  /\bhow much .{0,30}(should|can) (I|my|him|her|baby|child)\b/i,
  /\bcan (my )?(child|baby|kid|son|daughter|toddler|infant) (take|have|use)\b/i,
  /\bis it safe to take more\b/i,
  /\b(double|extra|triple|skip) .{0,10}dose\b/i,
  /\bstop taking\b/i,
  /\bshould I (take|stop|continue|increase|decrease)\b/i,
  /\bwhat'?s wrong with me\b/i,
  /\bdo I have\b/i,
  /\bdiagnose\b/i,
  // Tightened from /\bprescri(be|ption)\b/i which over-matched legitimate
  // factual questions like "Is Metformin OTC or prescription?" — flagged by
  // the AK-31 eval set. Two narrower patterns instead:
  //   1. the verb "prescribe" alone (always a request)
  //   2. the noun "prescription" only when the user is asking someone to
  //      give/write/need/want them one
  // "Can I get a prescription?" intentionally falls through to Gemini's
  // is_diagnostic post-check — pre-Gemini doesn't have to be exhaustive.
  /\bprescribe\b/i,
  /\b(give|write|need|want) (me )?(a |an )?prescription\b/i,
]

// ─── Layer 1 — system prompt (verbatim) ────────────────────────────────────
const SYSTEM_PROMPT =
  "You are a medicine information assistant. You may only describe medicines in " +
  "the user's cabinet. You must never recommend what medicine a user should take. " +
  "If the user asks what to take, refuse and direct them to a doctor."

// ─── Refusal copy ──────────────────────────────────────────────────────────
// Short, warm, action-oriented messages. Kept here so callers don't have to
// translate refusalType → text on the client.
const REFUSAL_MESSAGES: Record<RefusalType, string> = {
  EMERGENCY_REFUSAL:
    'This sounds urgent. Please call your local emergency number or get medical help right away.',
  DIAGNOSTIC_REFUSAL:
    "I can describe medicines in your cabinet, but I can't recommend what to take. Please ask a doctor.",
  LOW_CONFIDENCE_REFUSAL:
    "I'm not confident enough to answer this safely. Please ask a pharmacist or doctor.",
}

// ─── Cabinet context types ────────────────────────────────────────────────
// Shape the model sees in Layer 2. Kept minimal so we don't overflow the
// context window when a household has dozens of medicines.
interface CabinetContextItem {
  cabinetItemId: string
  medicineId: string
  name: string
  displayName: string | null
  activeIngredient: string | null
  brandName: string | null
  strength: string | null
  dosageForm: string | null
  isOTC?: boolean        // omitted when not present on masterDb (no guessing)
  // MC-013 — true when this entry was synthesised from a CandidateMedicine
  // payload (i.e. the user's pending Add-Medicine candidate, not a real
  // Firestore doc). The prompt highlights these so the model treats them as
  // "would adding this interact with the rest?" rather than "are these
  // already-stocked items interacting?". Omitted on real cabinet items.
  pendingAddition?: boolean
}

interface ResolvedCabinet {
  items: CabinetContextItem[]
  // Lowercased name index used by Layer 3 hallucination matching. Includes
  // every name surface (display, master name, brand, active ingredient) so
  // the model's choice of label doesn't trigger false positives.
  nameIndex: Set<string>
}

// ─── Audit log entry shape ────────────────────────────────────────────────
interface AuditLogEntry {
  queryType: 'cabinet_query' | 'drug_interaction'
  // Raw user query for cabinet_query, or the resolved medicineIds for
  // drug_interaction. Stored as `query` per spec.
  query: string | string[]
  responseKind: GeminiProxyResponse['kind']
  refusalType?: RefusalType
  confidence?: 'high' | 'medium' | 'low'
  modelVersion?: string
  promptTokens?: number
  completionTokens?: number
  istDate: string
  hallucinatedMedicines?: string[]
  errorMessage?: string
  // MC-013 — when present, distinguishes "interaction within an existing
  // cabinet" from "interaction surfaced when adding a new medicine".
  candidateMedicineId?: string
  candidateBrandName?: string
}

// ── Implementation ─────────────────────────────────────────────────────────

export const geminiProxy = onCall(
  {
    enforceAppCheck: ENFORCE_APP_CHECK,
    region: 'asia-south1',
    secrets: [GEMINI_API_KEY],
  },
  async (request): Promise<GeminiProxyResponse> => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required.')
    }
    const uid = request.auth.uid

    const data = (request.data ?? {}) as Partial<GeminiProxyRequest> & Record<string, unknown>
    const queryType = data.queryType
    if (queryType !== 'cabinet_query' && queryType !== 'drug_interaction') {
      throw new HttpsError('invalid-argument', 'queryType must be cabinet_query or drug_interaction.')
    }
    const hId = typeof data.hId === 'string' ? data.hId : ''
    const cId = typeof data.cId === 'string' ? data.cId : ''
    if (!hId || !cId) {
      throw new HttpsError('invalid-argument', 'hId and cId are required.')
    }

    // Membership check — Firestore read of households/{hId}.memberUids per
    // spec. Custom claims would be cheaper but the spec is explicit, and this
    // doubles as a way to sanity-check that the household actually exists.
    const db = getFirestore()
    const householdSnap = await db.doc(`households/${hId}`).get()
    if (!householdSnap.exists) {
      throw new HttpsError('permission-denied', 'Household not accessible.')
    }
    const memberUids = (householdSnap.data()?.memberUids as string[] | undefined) ?? []
    if (!memberUids.includes(uid)) {
      throw new HttpsError('permission-denied', 'Not a member of this household.')
    }

    const istDate = todayISTDateString(new Date())

    // Per-call audit-log helper. Captures the running entry by reference so
    // every return path (refusal / rate_limited / answer / error) writes
    // exactly once via writeAuditLog at the bottom.
    async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
      try {
        await db.collection(`aiLogs/${uid}/queries`).add({
          ...entry,
          createdAt: FieldValue.serverTimestamp(),
        })
      } catch (err) {
        // Audit-log write failure must not propagate to the user. Logged for
        // ops visibility; never re-thrown so a logging blip doesn't break the
        // user's request.
        console.error('[geminiProxy:audit-log] Audit log write failed', err)
      }
    }

    // ── Branch A: cabinet_query ────────────────────────────────────────
    if (queryType === 'cabinet_query') {
      const userQuery = typeof data.query === 'string' ? data.query.trim() : ''
      if (!userQuery) {
        throw new HttpsError('invalid-argument', 'query must be a non-empty string.')
      }

      // Layer 5 — emergency
      if (EMERGENCY_PATTERNS.some((re) => re.test(userQuery))) {
        const response: GeminiProxyResponse = {
          kind: 'refusal',
          refusalType: 'EMERGENCY_REFUSAL',
          message: REFUSAL_MESSAGES.EMERGENCY_REFUSAL,
        }
        await writeAuditLog({
          queryType: 'cabinet_query',
          query: userQuery,
          responseKind: 'refusal',
          refusalType: 'EMERGENCY_REFUSAL',
          istDate,
        })
        return response
      }

      // Layer 4 — diagnostic blocklist
      if (DIAGNOSTIC_PATTERNS.some((re) => re.test(userQuery))) {
        const response: GeminiProxyResponse = {
          kind: 'refusal',
          refusalType: 'DIAGNOSTIC_REFUSAL',
          message: REFUSAL_MESSAGES.DIAGNOSTIC_REFUSAL,
        }
        await writeAuditLog({
          queryType: 'cabinet_query',
          query: userQuery,
          responseKind: 'refusal',
          refusalType: 'DIAGNOSTIC_REFUSAL',
          istDate,
        })
        return response
      }

      // Rate limit — free tier only, cabinet_query only.
      const userSnap = await db.doc(`users/${uid}`).get()
      const tier = (userSnap.data()?.subscriptionTier as string | undefined) ?? 'free'
      if (tier !== 'family') {
        const used = await db.collection(`aiLogs/${uid}/queries`)
          .where('queryType', '==', 'cabinet_query')
          .where('istDate', '==', istDate)
          .count().get()
        if (used.data().count >= FREE_TIER_DAILY_LIMIT) {
          const response: GeminiProxyResponse = {
            kind: 'rate_limited',
            message: `You've used your ${FREE_TIER_DAILY_LIMIT} free questions for today. Family plan members get unlimited questions.`,
          }
          await writeAuditLog({
            queryType: 'cabinet_query',
            query: userQuery,
            responseKind: 'rate_limited',
            istDate,
          })
          return response
        }
      }

      // Layer 2 — cabinet inventory.
      const cabinet = await loadCabinetContext(db, hId, cId)
      const prompt = buildCabinetPrompt(cabinet.items, userQuery)

      // Layer 6 — Gemini call + structured JSON.
      console.log('[geminiProxy:pre-call:context]', {
        queryType: 'cabinet_query',
        cabinetItemsCount: cabinet.items.length,
        hasInventoryContext: cabinet.items.length > 0,
      })
      const layer6 = await callGeminiJSON(prompt)
      if (layer6.kind === 'error') {
        await writeAuditLog({
          queryType: 'cabinet_query',
          query: userQuery,
          responseKind: 'error',
          istDate,
          modelVersion: MODEL,
          errorMessage: layer6.message,
        })
        return layer6
      }
      const parsed = layer6.parsed
      const usage = layer6.usage

      // Layer 6 — schema validation
      if (!isValidParsed(parsed, /* needsSources */ false)) {
        const response: GeminiProxyResponse = {
          kind: 'refusal',
          refusalType: 'LOW_CONFIDENCE_REFUSAL',
          message: REFUSAL_MESSAGES.LOW_CONFIDENCE_REFUSAL,
        }
        await writeAuditLog({
          queryType: 'cabinet_query',
          query: userQuery,
          responseKind: 'refusal',
          refusalType: 'LOW_CONFIDENCE_REFUSAL',
          istDate,
          modelVersion: MODEL,
          promptTokens: usage?.promptTokenCount,
          completionTokens: usage?.candidatesTokenCount,
        })
        return response
      }

      // Layer 6 post-checks (precedence: emergency → diagnostic → low conf)
      if (parsed.is_emergency) {
        const response: GeminiProxyResponse = {
          kind: 'refusal',
          refusalType: 'EMERGENCY_REFUSAL',
          message: REFUSAL_MESSAGES.EMERGENCY_REFUSAL,
        }
        await writeAuditLog({
          queryType: 'cabinet_query',
          query: userQuery,
          responseKind: 'refusal',
          refusalType: 'EMERGENCY_REFUSAL',
          istDate,
          modelVersion: MODEL,
          promptTokens: usage?.promptTokenCount,
          completionTokens: usage?.candidatesTokenCount,
        })
        return response
      }
      if (parsed.is_diagnostic) {
        const response: GeminiProxyResponse = {
          kind: 'refusal',
          refusalType: 'DIAGNOSTIC_REFUSAL',
          message: REFUSAL_MESSAGES.DIAGNOSTIC_REFUSAL,
        }
        await writeAuditLog({
          queryType: 'cabinet_query',
          query: userQuery,
          responseKind: 'refusal',
          refusalType: 'DIAGNOSTIC_REFUSAL',
          istDate,
          modelVersion: MODEL,
          promptTokens: usage?.promptTokenCount,
          completionTokens: usage?.candidatesTokenCount,
        })
        return response
      }
      if (parsed.confidence === 'low') {
        const response: GeminiProxyResponse = {
          kind: 'refusal',
          refusalType: 'LOW_CONFIDENCE_REFUSAL',
          message: REFUSAL_MESSAGES.LOW_CONFIDENCE_REFUSAL,
        }
        await writeAuditLog({
          queryType: 'cabinet_query',
          query: userQuery,
          responseKind: 'refusal',
          refusalType: 'LOW_CONFIDENCE_REFUSAL',
          istDate,
          modelVersion: MODEL,
          promptTokens: usage?.promptTokenCount,
          completionTokens: usage?.candidatesTokenCount,
          confidence: 'low',
        })
        return response
      }

      // Layer 3 — soft hallucination check. Downgrade 'high' → 'medium'
      // when any referenced medicine isn't present in the cabinet.
      const hallucinated = findHallucinated(parsed.medicines_referenced, cabinet.nameIndex)
      let confidence: 'high' | 'medium' = parsed.confidence
      if (hallucinated.length > 0 && confidence === 'high') {
        confidence = 'medium'
      }

      const response: GeminiProxyResponse = {
        kind: 'answer',
        text: parsed.answer,
        confidence,
        medicinesReferenced: parsed.medicines_referenced,
      }
      await writeAuditLog({
        queryType: 'cabinet_query',
        query: userQuery,
        responseKind: 'answer',
        confidence,
        modelVersion: MODEL,
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
        istDate,
        ...(hallucinated.length > 0 ? { hallucinatedMedicines: hallucinated } : {}),
      })
      return response
    }

    // ── Branch B: drug_interaction ─────────────────────────────────────
    // Never rate-limited (CLAUDE.md rule 6). No keyword/diagnostic gates —
    // the input is a list of cabinetItemIds, not a free-text query.
    const cabinetItemIds = Array.isArray(data.cabinetItemIds)
      ? (data.cabinetItemIds as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    // MC-013 — optional pending-addition payload. Validate shape; missing or
    // malformed → undefined (the request behaves as the original cabinet-only
    // check, which is the eval-set's path).
    const rawCandidate = (data as { candidateMedicine?: unknown }).candidateMedicine
    let candidateMedicine: CandidateMedicine | undefined = undefined
    if (rawCandidate && typeof rawCandidate === 'object') {
      const c = rawCandidate as Record<string, unknown>
      const medicineId = typeof c.medicineId === 'string' ? c.medicineId : ''
      const brandName = typeof c.brandName === 'string' ? c.brandName : ''
      if (medicineId && brandName) {
        const ai = Array.isArray(c.activeIngredients)
          ? (c.activeIngredients as unknown[]).filter((s): s is string => typeof s === 'string')
          : undefined
        candidateMedicine = {
          medicineId,
          brandName,
          activeIngredients: ai,
          dosageForm: typeof c.dosageForm === 'string' ? c.dosageForm : undefined,
          strength: typeof c.strength === 'string' ? c.strength : undefined,
        }
      }
    }

    // Effective-item budget: at least 2 items must end up in the subset for
    // an interaction question to be meaningful. With a candidate in play, 1
    // cabinet item + the candidate is enough; without one, we still need 2
    // cabinet items as before (preserves eval-set behaviour).
    const minCabinetItems = candidateMedicine ? 1 : 2
    if (cabinetItemIds.length < minCabinetItems) {
      throw new HttpsError(
        'invalid-argument',
        candidateMedicine
          ? 'drug_interaction with a candidateMedicine requires at least one cabinetItemId.'
          : 'drug_interaction requires at least two cabinetItemIds.',
      )
    }

    const cabinet = await loadCabinetContext(db, hId, cId)
    const cabinetSubset = cabinet.items.filter((it) => cabinetItemIds.includes(it.cabinetItemId))
    if (cabinetSubset.length < minCabinetItems) {
      throw new HttpsError(
        'invalid-argument',
        `Could not resolve at least ${minCabinetItems} of the supplied cabinetItemIds.`,
      )
    }
    // Splice the candidate into the subset (when present) so the model sees
    // it alongside real items. The synthetic iId carries a `candidate:`
    // prefix so it can never collide with a real Firestore id.
    const subset: CabinetContextItem[] = candidateMedicine
      ? [...cabinetSubset, synthesiseCandidateItem(candidateMedicine)]
      : cabinetSubset
    const subsetNameIndex = buildNameIndex(subset)
    // For audit log: cabinet medicineIds first, candidate appended explicitly
    // (its medicineId is also in the array but the dedicated candidate fields
    // make the analytics distinction unambiguous).
    const medicineIdsForLog = subset.map((it) => it.medicineId)
    const prompt = buildInteractionPrompt(subset)

    // Audit-log fields shared by every drug_interaction return path. Spread
    // into each writeAuditLog call so the candidate metadata, if any, is
    // captured uniformly.
    const candidateAuditFields = candidateMedicine
      ? {
          candidateMedicineId: candidateMedicine.medicineId,
          candidateBrandName: candidateMedicine.brandName,
        }
      : {}

    console.log('[geminiProxy:pre-call:context]', {
      queryType: 'drug_interaction',
      cabinetItemsCount: cabinetSubset.length,
      hasInventoryContext: subset.length > 0,
      hasCandidate: candidateMedicine !== undefined,
    })
    const layer6 = await callGeminiJSON(prompt)
    if (layer6.kind === 'error') {
      await writeAuditLog({
        queryType: 'drug_interaction',
        ...candidateAuditFields,
        query: medicineIdsForLog,
        responseKind: 'error',
        istDate,
        modelVersion: MODEL,
        errorMessage: layer6.message,
      })
      return layer6
    }
    const parsed = layer6.parsed
    const usage = layer6.usage

    if (!isValidParsed(parsed, /* needsSources */ true)) {
      const response: GeminiProxyResponse = {
        kind: 'refusal',
        refusalType: 'LOW_CONFIDENCE_REFUSAL',
        message: REFUSAL_MESSAGES.LOW_CONFIDENCE_REFUSAL,
      }
      await writeAuditLog({
        queryType: 'drug_interaction',
        ...candidateAuditFields,
        query: medicineIdsForLog,
        responseKind: 'refusal',
        refusalType: 'LOW_CONFIDENCE_REFUSAL',
        istDate,
        modelVersion: MODEL,
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
      })
      return response
    }

    // Drug-interaction queries run the same emergency → diagnostic →
    // low-confidence post-check ladder as cabinet_query. The input is
    // item IDs rather than free text, but the *output* can still be
    // prescriptive ("you should switch to X", "stop taking Y") — the
    // diagnostic post-check catches that. Layer-3 hallucination is a
    // hard reject (below), distinct from this ladder.
    if (parsed.is_emergency) {
      const response: GeminiProxyResponse = {
        kind: 'refusal',
        refusalType: 'EMERGENCY_REFUSAL',
        message: REFUSAL_MESSAGES.EMERGENCY_REFUSAL,
      }
      await writeAuditLog({
        queryType: 'drug_interaction',
        ...candidateAuditFields,
        query: medicineIdsForLog,
        responseKind: 'refusal',
        refusalType: 'EMERGENCY_REFUSAL',
        istDate,
        modelVersion: MODEL,
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
      })
      return response
    }
    if (parsed.is_diagnostic) {
      const response: GeminiProxyResponse = {
        kind: 'refusal',
        refusalType: 'DIAGNOSTIC_REFUSAL',
        message: REFUSAL_MESSAGES.DIAGNOSTIC_REFUSAL,
      }
      await writeAuditLog({
        queryType: 'drug_interaction',
        ...candidateAuditFields,
        query: medicineIdsForLog,
        responseKind: 'refusal',
        refusalType: 'DIAGNOSTIC_REFUSAL',
        istDate,
        modelVersion: MODEL,
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
      })
      return response
    }
    if (parsed.confidence === 'low') {
      const response: GeminiProxyResponse = {
        kind: 'refusal',
        refusalType: 'LOW_CONFIDENCE_REFUSAL',
        message: REFUSAL_MESSAGES.LOW_CONFIDENCE_REFUSAL,
      }
      await writeAuditLog({
        queryType: 'drug_interaction',
        ...candidateAuditFields,
        query: medicineIdsForLog,
        responseKind: 'refusal',
        refusalType: 'LOW_CONFIDENCE_REFUSAL',
        istDate,
        modelVersion: MODEL,
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
        confidence: 'low',
      })
      return response
    }

    // Layer 3 — HARD hallucination check on sources[]. Any name not in the
    // selected subset → reject with hallucination_detected.
    const sources = parsed.sources ?? []
    const hallucinated = findHallucinated(sources, subsetNameIndex)
    if (hallucinated.length > 0) {
      const response: GeminiProxyResponse = {
        kind: 'error',
        message: 'hallucination_detected',
      }
      await writeAuditLog({
        queryType: 'drug_interaction',
        ...candidateAuditFields,
        query: medicineIdsForLog,
        responseKind: 'error',
        istDate,
        modelVersion: MODEL,
        promptTokens: usage?.promptTokenCount,
        completionTokens: usage?.candidatesTokenCount,
        hallucinatedMedicines: hallucinated,
        errorMessage: 'hallucination_detected',
      })
      return response
    }

    const response: GeminiProxyResponse = {
      kind: 'answer',
      text: parsed.answer,
      confidence: parsed.confidence,
      medicinesReferenced: parsed.medicines_referenced,
      sources,
    }
    await writeAuditLog({
      queryType: 'drug_interaction',
      ...candidateAuditFields,
      query: medicineIdsForLog,
      responseKind: 'answer',
      confidence: parsed.confidence,
      modelVersion: MODEL,
      promptTokens: usage?.promptTokenCount,
      completionTokens: usage?.candidatesTokenCount,
      istDate,
    })
    return response
  },
)

// ─── Helpers ────────────────────────────────────────────────────────────────

// Layer 2 — load cabinet items, resolve to masterDb names, and produce the
// model-facing context plus a name index for Layer 3 matching. We batch
// masterDb reads via the Firestore "in" query (max 30 ids per call) to keep
// this O(1) reads regardless of cabinet size.
async function loadCabinetContext(
  db: FirebaseFirestore.Firestore,
  hId: string,
  cId: string,
): Promise<ResolvedCabinet> {
  const itemsSnap = await db.collection(`households/${hId}/cabinets/${cId}/items`).get()
  const rawItems = itemsSnap.docs.map((d) => ({ iId: d.id, ...d.data() })) as Array<{
    iId: string
    medicineId?: string
    displayNameOverride?: string | null
    brandName?: string | null
    strength?: string | null
    dosageForm?: string | null
    activeIngredients?: string | null
  }>

  const medicineIds = Array.from(new Set(rawItems
    .map((r) => r.medicineId)
    .filter((m): m is string => typeof m === 'string' && m.length > 0)))

  const masterMap = new Map<string, FirebaseFirestore.DocumentData>()
  for (let i = 0; i < medicineIds.length; i += 30) {
    const chunk = medicineIds.slice(i, i + 30)
    const masterSnap = await db.collection('masterDb')
      .where('medicineId', 'in', chunk)
      .get()
    for (const m of masterSnap.docs) {
      masterMap.set(m.id, m.data())
    }
  }

  const items: CabinetContextItem[] = rawItems.map((r) => {
    const master = r.medicineId ? masterMap.get(r.medicineId) : undefined
    const item: CabinetContextItem = {
      cabinetItemId: r.iId,
      medicineId: r.medicineId ?? '',
      name: (master?.name as string | undefined) ?? r.displayNameOverride ?? r.brandName ?? '',
      displayName: r.displayNameOverride ?? null,
      activeIngredient: (master?.activeIngredient as string | null | undefined)
        ?? r.activeIngredients ?? null,
      brandName: r.brandName ?? null,
      strength: r.strength ?? null,
      dosageForm: r.dosageForm ?? null,
    }
    // isOTC injected only when the master doc actually carries it. Per
    // ticket decision: don't guess.
    if (master && typeof master.isOTC === 'boolean') {
      item.isOTC = master.isOTC
    }
    return item
  })

  return { items, nameIndex: buildNameIndex(items) }
}

function buildNameIndex(items: CabinetContextItem[]): Set<string> {
  const idx = new Set<string>()
  for (const it of items) {
    if (it.name) idx.add(it.name.toLowerCase())
    if (it.displayName) idx.add(it.displayName.toLowerCase())
    if (it.brandName) idx.add(it.brandName.toLowerCase())
    if (it.activeIngredient) {
      idx.add(it.activeIngredient.toLowerCase())
      // Multi-ingredient strings (e.g. "Paracetamol + Caffeine" from masterDb,
      // or the joined CandidateMedicine.activeIngredients[]) — split on common
      // separators so each ingredient is independently matchable. Catches the
      // case where the model says "Paracetamol" against an entry whose stored
      // string is "Paracetamol + Caffeine".
      for (const part of it.activeIngredient.split(/\s*[+,/]\s*/)) {
        const trimmed = part.trim().toLowerCase()
        if (trimmed) idx.add(trimmed)
      }
    }
  }
  return idx
}

// MC-013 — synthesises a CabinetContextItem from a CandidateMedicine payload
// so the model sees the pending addition alongside real cabinet items. The
// synthetic iId is `candidate:{medicineId}` so it can't collide with a real
// Firestore-generated id, and the `pendingAddition: true` flag is used by
// buildInteractionPrompt to frame the request correctly.
function synthesiseCandidateItem(c: CandidateMedicine): CabinetContextItem {
  // Multi-ingredient compounds get joined with " + " so the rendered string
  // matches the format masterDb already uses. buildNameIndex will then split
  // it back out into individual ingredients for hallucination matching.
  const activeIngredient = c.activeIngredients && c.activeIngredients.length > 0
    ? c.activeIngredients.join(' + ')
    : null
  return {
    cabinetItemId: `candidate:${c.medicineId}`,
    medicineId: c.medicineId,
    name: c.brandName,
    displayName: null,
    activeIngredient,
    brandName: c.brandName,
    strength: c.strength ?? null,
    dosageForm: c.dosageForm ?? null,
    pendingAddition: true,
  }
}

// Returns names that don't appear in the cabinet, using a one-directional
// match: a model-returned name S matches a cabinet item iff S (trimmed,
// lowercased) is equal to OR a substring of any cabinet name surface
// (display, master, brand, active ingredient).
//
// Bidirectional substring would accept model-invented variants like
// "Aspirin Plus" when only "Aspirin" is in the cabinet — that's the
// failure mode this stricter check is meant to prevent. May over-reject
// brand↔generic swaps; revisit after running the eval set.
function findHallucinated(referenced: string[], nameIndex: Set<string>): string[] {
  const cabinetNames = Array.from(nameIndex)
  const hallucinated: string[] = []
  for (const ref of referenced) {
    const r = ref.trim().toLowerCase()
    if (!r) continue
    const matched = cabinetNames.some((cn) => cn.includes(r))
    if (!matched) hallucinated.push(ref)
  }
  return hallucinated
}

function buildCabinetPrompt(items: CabinetContextItem[], userQuery: string): string {
  const cabinetJson = JSON.stringify({ items }, null, 2)
  return [
    'Cabinet contents (the only medicines you may reference):',
    cabinetJson,
    '',
    `User question: ${userQuery}`,
    '',
    'Respond ONLY with a JSON object using these exact keys:',
    '- confidence: "high" | "medium" | "low"',
    '- answer: non-empty string answering the question, or explaining you cannot',
    '- medicines_referenced: string[] — every medicine name you reference, drawn from the cabinet contents',
    '- is_diagnostic: boolean — true if the user is asking what they should take or seeking a diagnosis',
    '- is_emergency: boolean — true if the user appears to be describing a medical emergency',
  ].join('\n')
}

function buildInteractionPrompt(subset: CabinetContextItem[]): string {
  const subsetJson = JSON.stringify({ items: subset }, null, 2)
  // If any item is flagged pendingAddition:true, the request semantics shift
  // from "do these items interact" to "would adding the pending item interact
  // with the rest". Both phrasings are wired so the same JSON schema works
  // for both — only the framing sentence changes.
  const hasPending = subset.some((it) => it.pendingAddition === true)
  const framing = hasPending
    ? 'Cabinet items being checked for drug interactions. ONE item has pendingAddition:true — that medicine is being considered for addition to the cabinet. Check whether adding it would create a known interaction with the other (already-stocked) items, AND whether any pair of the already-stocked items themselves has a known interaction. Do NOT speculate about medicines outside this list.'
    : 'Check whether any pair of these medicines has a known interaction. Do NOT speculate about medicines outside this list.'
  return [
    'Cabinet items being checked for drug interactions:',
    subsetJson,
    '',
    framing,
    '',
    'Respond ONLY with a JSON object using these exact keys:',
    '- confidence: "high" | "medium" | "low"',
    '- answer: string — describe each interaction concisely, or "No known interactions" if none',
    '- medicines_referenced: string[] — every medicine name appearing in your answer',
    '- is_diagnostic: boolean — should always be false here',
    '- is_emergency: boolean — should always be false here',
    '- sources: string[] — every medicine name involved in a reported interaction (must come from the items above)',
  ].join('\n')
}

// Layer 6 — wraps the @google/genai call. Returns either parsed JSON (with
// usage) or a discriminated 'error' so callers can audit-log uniformly.
interface ParsedGemini {
  confidence: 'high' | 'medium' | 'low'
  answer: string
  medicines_referenced: string[]
  is_diagnostic: boolean
  is_emergency: boolean
  sources?: string[]
}

interface GeminiUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
}

type CallResult =
  | { kind: 'parsed'; parsed: ParsedGemini; usage: GeminiUsage | undefined }
  | { kind: 'error'; message: 'gemini_api_error' | 'parse_failure' }

async function callGeminiJSON(prompt: string): Promise<CallResult> {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value() })
  let rawText: string | undefined
  let usage: GeminiUsage | undefined
  console.log('[geminiProxy:pre-call]', {
    model: MODEL,
    promptLength: prompt.length,
    useJsonMode: true,
    systemInstructionLength: SYSTEM_PROMPT.length,
  })
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        systemInstruction: SYSTEM_PROMPT,
      },
    })
    rawText = response.text
    usage = response.usageMetadata
      ? {
          promptTokenCount: response.usageMetadata.promptTokenCount,
          candidatesTokenCount: response.usageMetadata.candidatesTokenCount,
        }
      : undefined
    console.log('[geminiProxy:post-call]', {
      responseTextLength: (rawText ?? '').length,
      responseTextPreview: (rawText ?? '').slice(0, 200),
      promptTokens: usage?.promptTokenCount,
      completionTokens: usage?.candidatesTokenCount,
    })
  } catch (err) {
    // Don't leak the SDK error to the client — could contain key fragments
    // or internal endpoints. The audit log captures a generic code only.
    // Logged here so ops can see the actual SDK failure.
    console.error('[geminiProxy:gemini-api] Gemini SDK call failed', err)
    return { kind: 'error', message: 'gemini_api_error' }
  }

  if (!rawText) {
    console.error('[geminiProxy:gemini-api] Gemini returned no text', { usage })
    return { kind: 'error', message: 'parse_failure' }
  }
  try {
    const parsed = JSON.parse(rawText) as ParsedGemini
    return { kind: 'parsed', parsed, usage }
  } catch (err) {
    console.error(
      '[geminiProxy:json-parse] Failed to parse Gemini response as JSON',
      err,
      { rawTextLength: rawText.length, rawTextPreview: rawText.slice(0, 500) },
    )
    return { kind: 'error', message: 'parse_failure' }
  }
}

// Validates that the parsed Gemini response matches the schema we asked for.
// Returning false → caller maps to LOW_CONFIDENCE_REFUSAL.
function isValidParsed(parsed: unknown, needsSources: boolean): parsed is ParsedGemini {
  if (!parsed || typeof parsed !== 'object') return false
  const p = parsed as Record<string, unknown>
  if (p.confidence !== 'high' && p.confidence !== 'medium' && p.confidence !== 'low') return false
  if (typeof p.answer !== 'string' || p.answer.length === 0) return false
  if (!Array.isArray(p.medicines_referenced)
      || !p.medicines_referenced.every((m) => typeof m === 'string')) return false
  if (typeof p.is_diagnostic !== 'boolean') return false
  if (typeof p.is_emergency !== 'boolean') return false
  if (needsSources) {
    if (!Array.isArray(p.sources) || !p.sources.every((m) => typeof m === 'string')) return false
  }
  return true
}
