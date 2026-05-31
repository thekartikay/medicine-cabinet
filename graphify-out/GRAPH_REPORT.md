# Graph Report - .  (2026-05-31)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 915 nodes · 1540 edges · 74 communities (54 shown, 20 thin omitted)
- Extraction: 98% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.71)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `77a7faaa`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]

## God Nodes (most connected - your core abstractions)
1. `getFirestoreContext()` - 57 edges
2. `todayISTString()` - 19 edges
3. `compilerOptions` - 17 edges
4. `CaregiverGrant` - 17 edges
5. `compilerOptions` - 16 edges
6. `InviteMember` - 15 edges
7. `auth` - 15 edges
8. `compilerOptions` - 12 edges
9. `functions` - 10 edges
10. `getHousehold()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `MediCab Privacy Policy` --conceptually_related_to--> `Identity and Auth Design`  [INFERRED]
  public/privacy-policy.md → Documents/05_IDENTITY_AND_AUTH_DESIGN.md.pdf
- `Identity & Auth MVP Design (PDF)` --semantically_similar_to--> `Identity & Authentication — MVP Design`  [EXTRACTED] [semantically similar]
  Documents/Identity_and_auth_design_mvp.pdf → Documents/Identity_and_auth_design_mvp.md
- `MediCab Hi-Fi Prototype (Print)` --conceptually_related_to--> `Identity & Auth — Screens and User Flows`  [INFERRED]
  Documents/MediCab — Hi-Fi Prototype (Print).pdf → Documents/Identity_and_auth_screens_mvp.md
- `React + TypeScript + Vite README` --conceptually_related_to--> `MediCab Master Project Context`  [INFERRED]
  README.md → CLAUDE.md
- `Treatment (User↔Medicine relationship)` --conceptually_related_to--> `logDose() transaction`  [INFERRED]
  Documents/Entities_interactions_constraints_v1.0.md → CLAUDE.md

## Import Cycles
- None detected.

## Communities (74 total, 20 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (46): Day-30 retention (highest leverage), Economics & Revenue Model, Subscription revenue stream, Acquisition trigger taxonomy, Customer Segments & Cohorts, Local Executor cohort, NRI household cohort (Priya pattern), Regimen complexity retention predictor (+38 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (35): AnswerConfidence, AnswerResponse, CabinetQueryRequest, CandidateMedicine, DrugInteractionRequest, ErrorResponse, GeminiProxyRequest, GeminiProxyResponse (+27 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (39): AnswerConfidence, AnswerResponse, app, args, auth, CabinetQueryRequest, Category, cats (+31 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (40): getFirestoreContext(), addressesCollectionPath(), addressPath(), cabinetPath(), dosesCollectionPath(), getDefaultCabinetId(), itemPath(), itemsCollectionPath() (+32 more)

### Community 4 - "Community 4"
Cohesion: 0.08
Nodes (24): errorMessageFor(), Props, REFUSAL_HEADLINE, renderResult(), ALLOWED_DOSAGE_FORMS, byExpirySoonest(), CabinetTab(), CabinetView (+16 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (25): ConflictType, buildSlotId(), ALLOWED_DOSAGE_FORMS, CATEGORY_LABELS, CATEGORY_SUB, DAY_LABELS, DAY_NAMES, detectIngredientCollision() (+17 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (31): dependencies, bcryptjs, firebase-admin, firebase-functions, @google/genai, devDependencies, eslint, eslint-config-google (+23 more)

### Community 7 - "Community 7"
Cohesion: 0.16
Nodes (28): AcceptGrantResp, adminApp, adminAuth, adminDb, cleanup(), clientApp, clientAuth, clientDb (+20 more)

### Community 8 - "Community 8"
Cohesion: 0.08
Nodes (21): auth, db, deleteAccount, deleteTreatment, markMissedDoses, messaging, onCabinetItemWritten, onLogWritten (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (12): Route, Params, Props, State, BADGE_MAP, State, clearCaregiverSession(), getCaregiverSession() (+4 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (20): app, auth, CABINET_NEEDLES, db, ensureAuthUser(), expiryDateString(), loadMatchedMasterDocs(), main() (+12 more)

### Community 11 - "Community 11"
Cohesion: 0.11
Nodes (18): FOOD_LABELS, RetroLogSheetProps, RetroSlot, Cabinet, ConsentRecord, FoodTiming, NotificationType, PauseEntry (+10 more)

### Community 12 - "Community 12"
Cohesion: 0.10
Nodes (20): devDependencies, dotenv, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, fake-indexeddb, firebase-admin (+12 more)

### Community 13 - "Community 13"
Cohesion: 0.11
Nodes (13): Props, BADGE, CONFIRM_MESSAGES, Dashboard(), FOOD_LABELS, generatePastTimeOptions(), LogState, minsSinceScheduledHHMM() (+5 more)

### Community 14 - "Community 14"
Cohesion: 0.11
Nodes (18): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib, module, moduleDetection, moduleResolution (+10 more)

### Community 15 - "Community 15"
Cohesion: 0.18
Nodes (16): enrich(), ensureEnvironment(), extractBrandName(), extractDosageForm(), extractStrength(), initApp(), main(), MasterDbRecord (+8 more)

### Community 16 - "Community 16"
Cohesion: 0.13
Nodes (10): BottomSheetProps, CONFIRM_MESSAGES, generatePastTimeOptions(), LogState, nowHHMM(), nowISTHM(), Props, timeOfDayKey() (+2 more)

### Community 17 - "Community 17"
Cohesion: 0.11
Nodes (17): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution, noEmit (+9 more)

### Community 18 - "Community 18"
Cohesion: 0.18
Nodes (11): Props, Status, Props, ROLE_LABEL, WireTimestamp, acceptCaregiverGrant, createCaregiverGrant, listCaregiverGrants (+3 more)

### Community 19 - "Community 19"
Cohesion: 0.19
Nodes (16): emulators, auth, ui, firestore, indexes, functions, hosting, headers (+8 more)

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (17): dependencies, @capacitor/android, @capacitor/app, @capacitor/core, @capacitor/haptics, @capacitor/keyboard, @capacitor/local-notifications, @capacitor/push-notifications (+9 more)

### Community 21 - "Community 21"
Cohesion: 0.15
Nodes (11): app, ensureMessaging(), firebaseConfig, FirestoreContext, functions, requestNotificationPermission(), __resetFirestoreContextForTest(), Props (+3 more)

### Community 22 - "Community 22"
Cohesion: 0.13
Nodes (10): getSkipUrgency(), SKIP_REASON_LABELS, DayEntry, DayGroup, DoseHistory(), EntryStatus, Props, DoseLog (+2 more)

### Community 23 - "Community 23"
Cohesion: 0.13
Nodes (14): compileOnSave, compilerOptions, esModuleInterop, module, moduleResolution, noImplicitReturns, noUnusedLocals, outDir (+6 more)

### Community 24 - "Community 24"
Cohesion: 0.16
Nodes (12): Addresses(), computeJoinCode(), INVITE_TEXT, InviteMember(), InviteParams, LANGUAGES, Props, LANGUAGES (+4 more)

### Community 25 - "Community 25"
Cohesion: 0.14
Nodes (10): CountryCode, DEFAULT_CENTER, EMPTY_FORM, FormProps, FormState, LABEL_CHIPS, Props, View (+2 more)

### Community 26 - "Community 26"
Cohesion: 0.13
Nodes (13): ACUTE_ORAL, CHRONIC_INHALER, CHRONIC_INJECT, CHRONIC_ORAL, DEFS, getSkipReasonChips(), PREVENTIVE, PRN (+5 more)

### Community 27 - "Community 27"
Cohesion: 0.15
Nodes (10): dosePath(), itemEventPath(), itemEventsCollectionPath(), membersCollectionPath(), notificationsCollectionPath(), PATHS, restockRequestsCollectionPath(), getHousehold() (+2 more)

### Community 28 - "Community 28"
Cohesion: 0.16
Nodes (13): subscribeCabinetItems(), subscribeNotifications(), subscribeRestockRequests(), subscribeTodaySummary(), subscribeTreatments(), TodaySummary, ADMIN_HEADERS, b64url() (+5 more)

### Community 29 - "Community 29"
Cohesion: 0.24
Nodes (14): MediCab Documentation Index, MediCab Master Strategic Roadmap (20-Year Vision), NRI Diaspora Caregivers (Primary Market), Option B Pharmacy Chain Transition, The 12-Month Bet, Phase 1 Operational Playbook, 1mg / PharmEasy B2B API Delivery, Day 30 Retention Metric (+6 more)

### Community 30 - "Community 30"
Cohesion: 0.19
Nodes (11): resources, LANGUAGES, Props, LANGUAGES, Profile(), ProfileLang, Props, Role (+3 more)

### Community 31 - "Community 31"
Cohesion: 0.19
Nodes (13): consentVersionPath(), memberPath(), userPath(), createUserIfNew(), getConsentRecord(), getMemberDisplayName(), getUserDoc(), recordConsent() (+5 more)

### Community 32 - "Community 32"
Cohesion: 0.23
Nodes (10): todayISTString(), getStatus(), StockStatus, pastNDates(), istDateOf(), Props, timeAgo(), markAllNotificationsRead() (+2 more)

### Community 33 - "Community 33"
Cohesion: 0.30
Nodes (11): buildTodaySummaryForHousehold(), recountMember(), dateInTz(), dayOfWeekForDateInTz(), dayOfWeekForISTDate(), dayOfWeekInTz(), istSlotInstant(), previousDateInTz() (+3 more)

### Community 34 - "Community 34"
Cohesion: 0.20
Nodes (6): AuthErrorModalProps, FIREBASE_ERROR_MESSAGES, SUPPRESSED_ERROR_CODES, auth, Props, ProfileSetup

### Community 35 - "Community 35"
Cohesion: 0.22
Nodes (5): Country, googleProvider, formatMMSS(), SignIn(), View

### Community 36 - "Community 36"
Cohesion: 0.22
Nodes (9): formatISTTimeOfDay(), notifyCaregiverOnLog(), sendCaregiverPush(), zeroCabinetItemStock(), getSkipUrgency(), isStreakTrackedReason(), SKIP_REASON_LABELS, SKIP_URGENCY (+1 more)

### Community 37 - "Community 37"
Cohesion: 0.22
Nodes (9): scripts, build, dev, eval:cabinet, lint, preview, setup:eval-user, test:rules (+1 more)

### Community 38 - "Community 38"
Cohesion: 0.22
Nodes (4): AppState, Dashboard, HouseholdSummary, Role

### Community 39 - "Community 39"
Cohesion: 0.36
Nodes (8): backfill(), BackfillResult, ensureEnvironment(), initApp(), isEmpty(), main(), maskFromPhone(), MemberRecord

### Community 41 - "Community 41"
Cohesion: 0.25
Nodes (8): regimensCollectionPath(), treatmentsCollectionPath(), getActiveTreatmentMedicines(), getActiveTreatmentsWithRegimensForMember(), loadAllActiveRegimens(), loadLogsForDateRange(), loadTodaysDoses(), loadTodaysLogs()

### Community 44 - "Community 44"
Cohesion: 0.60
Nodes (5): backfillMembers(), backfillRegimens(), ensureEnvironment(), initApp(), main()

### Community 45 - "Community 45"
Cohesion: 0.53
Nodes (4): ensureEnvironment(), initApp(), main(), seed()

### Community 46 - "Community 46"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 48 - "Community 48"
Cohesion: 0.50
Nodes (3): detectPlatform(), Props, ConsentScreen

### Community 50 - "Community 50"
Cohesion: 0.50
Nodes (4): regimenPath(), addRegimen(), computeScheduleSummary(), updateRegimen()

### Community 55 - "Community 55"
Cohesion: 0.67
Nodes (3): Identity and Auth Design, MediCab Privacy Policy, DPDP Act Consent / Health Data

## Ambiguous Edges - Review These
- `Metrics & Success Criteria Framework` → `Prototype to MVP Gap Analysis`  [AMBIGUOUS]
  Documents/files_updated/06_PROTOTYPE_TO_MVP_GAP_ANALYSIS.md · relation: references

## Knowledge Gaps
- **386 isolated node(s):** `tsBuildInfoFile`, `target`, `lib`, `module`, `types` (+381 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Metrics & Success Criteria Framework` and `Prototype to MVP Gap Analysis`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `CabinetItem` connect `Community 4` to `Community 2`, `Community 3`, `Community 5`, `Community 11`, `Community 13`, `Community 16`, `Community 28`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `CaregiverGrant` connect `Community 18` to `Community 8`, `Community 11`, `Community 27`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `JoinHousehold` connect `Community 47` to `Community 8`, `Community 21`, `Community 38`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `tsBuildInfoFile`, `target`, `lib` to the rest of the system?**
  _386 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05893719806763285 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._