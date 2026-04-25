# Companion Architecture

This document explains the current companion-mode architecture in the app, including the backend runtime, storage model, prompt selection, local ML stack, memory system, and UI surfaces.

It reflects the current workspace state, including the latest companion UI pages that are implemented in the working tree.

## 1. What Companion Mode Is

Companion mode is a separate chat mode built for long-running, relationship-oriented conversations rather than scene-driven roleplay.

At a high level, companion mode changes five things:

1. It changes the prompt family used for generation.
2. It adds a persistent companion configuration under `character.companion`.
3. It maintains a live emotional and relationship state in `session.companionState`.
4. It uses a dedicated companion memory pipeline instead of the generic dynamic-memory summarizer/manager loop.
5. It exposes companion-oriented UI surfaces for memory and relationship state.

The main design principle is:

- ML-first, LLM-second

That means cheap, deterministic local ML handles routing, emotion classification, entity extraction, canonicalization, and memory retention logic. The LLM remains focused on reply generation and other creative language tasks.

## 2. Architecture Overview

The companion stack is split across four layers:

### 2.1 Data layer

Main files:

- `src/core/storage/schemas.ts`
- `src/core/storage/repo.ts`
- `src-tauri/src/chat_manager/types.rs`

Responsibilities:

- define the persistent companion shape on `Character`
- define live per-session companion state
- define enriched companion memory records
- choose prompt/template defaults when a session starts

### 2.2 Runtime layer

Main files:

- `src-tauri/src/chat_manager/companion/mod.rs`
- `src-tauri/src/chat_manager/companion/memory.rs`
- `src-tauri/src/chat_manager/memory/flow.rs`
- `src-tauri/src/chat_manager/prompting/prompt_engine.rs`
- `src-tauri/src/chat_manager/flows/completion.rs`
- `src-tauri/src/chat_manager/flows/continuation.rs`
- `src-tauri/src/chat_manager/flows/regenerate.rs`

Responsibilities:

- decide whether the current chat is companion or roleplay
- update emotional and relationship state from user turns
- run companion memory extraction and retention
- retrieve companion memories for prompt injection
- select the companion prompt template and render companion state

### 2.3 Local ML layer

Main files:

- `src-tauri/src/embedding/mod.rs`
- `src-tauri/src/embedding/specs.rs`
- `src-tauri/src/embedding/emotion.rs`
- `src-tauri/src/embedding/ner.rs`
- `src-tauri/src/embedding/router.rs`

Responsibilities:

- shared ONNX runtime initialization
- embedding inference
- emotion classification
- NER extraction
- zero-shot local routing/classification
- bundle installation and download state

### 2.4 UI layer

Main files:

- `src/ui/pages/characters/components/InteractionModeSelector.tsx`
- `src/ui/pages/characters/components/CompanionSoulEditor.tsx`
- `src/ui/pages/chats/CompanionMemoryPage.tsx`
- `src/ui/pages/chats/CompanionRelationshipPage.tsx`
- `src/ui/pages/chats/companionUi.tsx`
- `src/ui/pages/chats/components/ChatHeader.tsx`
- `src/ui/pages/chats/ChatSettings.tsx`
- `src/ui/navigation.ts`
- `src/App.tsx`

Responsibilities:

- character creation/editing for companion config
- companion memory inspection and manual management
- relationship/emotional state visualization
- routing users to companion pages when the current chat is in companion mode

## 3. Core Data Model

## 3.1 Character mode and companion config

Defined in `src/core/storage/schemas.ts`.

The character has:

- `mode: "roleplay" | "companion"`
- `companion?: CompanionConfig | null`

`CompanionConfig` contains four major sections:

1. `soul`
2. `relationshipDefaults`
3. `memory`
4. `prompting`

### Soul

`CompanionSoul` is the authored identity scaffold for the companion.

Text fields:

- `essence`
- `voice`
- `relationalStyle`
- `vulnerabilities`
- `habits`
- `boundaries`

Numeric submodels:

- `baselineAffect`
- `regulationStyle`

`baselineAffect` is the default emotional baseline:

- warmth
- trust
- calm
- vulnerability
- longing
- hurt
- tension
- irritation
- affectionIntensity
- reassuranceNeed

`regulationStyle` controls how raw emotion turns into visible emotional behavior:

- suppression
- volatility
- recoverySpeed
- conflictAvoidance
- reassuranceSeeking
- protestBehavior
- emotionalTransparency
- attachmentActivation
- pride

This is important: Soul is not memory. Soul is the authored psychological base that the runtime uses even before any conversation history exists.

### Relationship defaults

`relationshipDefaults` defines the starting relationship position:

- `closeness`
- `trust`
- `affection`
- `tension`

This seeds the live relationship state for a new companion session.

### Companion memory config

`CompanionMemoryConfig` defines:

- `enabled`
- `retrievalLimit`
- `maxEntries`
- `prioritizeRelationship`
- `prioritizeEpisodic`
- `useEmotionalSnapshots`

This is the policy layer for memory retrieval and retention.

### Prompting config

`CompanionPromptingConfig` defines:

- `promptTemplateId`
- `styleNotes`

This is intentionally separate from the normal roleplay `promptTemplateId`.

When the character is in companion mode, the app uses `character.companion.prompting.promptTemplateId` instead of reusing the roleplay prompt id.

## 3.2 Session state

Defined in `src/core/storage/schemas.ts` and mirrored in Rust in `src-tauri/src/chat_manager/companion/mod.rs`.

Each session can carry:

- `mode`
- `promptTemplateId`
- `companionState`
- `memoryEmbeddings`
- `memories`

The companion-specific live state is `companionState`.

It contains:

- `emotionalState`
- `relationshipState`
- `activeSignals`
- `updatedAt`

### EmotionalState

Tracks four emotion vectors:

- `felt`
- `expressed`
- `blocked`
- `momentum`

Plus:

- `activeDrivers`
- `confidence`
- `updatedAt`

This split is deliberate:

- `felt` = what the companion is internally carrying
- `expressed` = what comes through in output
- `blocked` = what is felt but suppressed
- `momentum` = direction of recent affective movement

### RelationshipState

Tracks:

- `closeness`
- `trust`
- `affection`
- `tension`
- `stability`
- `interactionCount`
- `lastInteractionAt`

This is a compact state machine for the relationship arc.

## 3.3 Companion memory record format

The canonical runtime structure is `MemoryEmbedding` in `src-tauri/src/chat_manager/types.rs`.

Companion mode reuses the same base record type but populates more fields than generic dynamic memory.

Important fields:

- `id`
- `text`
- `embedding`
- `created_at`
- `token_count`
- `is_cold`
- `last_accessed_at`
- `importance_score`
- `persistence_importance`
- `prompt_importance`
- `volatility`
- `is_pinned`
- `access_count`
- `match_score`
- `category`
- `canonical_entities`
- `fact_signature`
- `fact_polarity`
- `source_role`
- `superseded_by`
- `superseded_at`
- `supersedes`

This is the heart of the companion memory architecture.

Generic dynamic memory mostly cared about:

- text
- embedding
- importance
- hot/cold

Companion memory extends that into a more structured memory graph with:

- entity anchors
- contradiction-safe signatures
- source-aware retention
- multi-axis importance scoring
- supersession links

## 4. Session Creation and Prompt Selection

Main file:

- `src/core/storage/repo.ts`

When a new session is created in `createSession(...)`:

- the character is loaded
- `session.mode` is set from `character.mode`
- if the character is in companion mode, no scene opener is forced into the session
- `session.promptTemplateId` is set to:
  - `character.companion.prompting.promptTemplateId`
  - or the app companion default template id

This is the key behavioral difference:

- roleplay sessions are scene-oriented by default
- companion sessions are continuity-oriented by default

## 5. Prompt Architecture

Main file:

- `src-tauri/src/chat_manager/prompting/prompt_engine.rs`

Companion prompt behavior has two parts:

### 5.1 Companion default prompt rules

The built-in companion prompt entry includes rules like:

- stay fully in character
- prioritize emotional continuity and trust-building
- behave like an ongoing companion rather than an assistant
- avoid theatrical roleplay framing unless the conversation calls for it

This is the mode-level policy layer.

### 5.2 Template selection

At render time, the prompt engine checks whether companion mode is active.

If it is:

- it first prefers the session template if set
- otherwise it looks for `character.companion.prompting.promptTemplateId`
- otherwise it falls back to the app default companion template

This path is separate from normal roleplay prompt selection.

### 5.3 Injected companion state

The prompt engine renders `companion::render_prompt_state(session, character)` and injects:

- relationship percentages
- currently expressed emotional tone
- blocked emotional tone when relevant
- recent drivers
- Soul text:
  - essence
  - voice
  - relational style
  - vulnerabilities
  - habits
  - boundaries
- companion style notes
- regulation hints derived from suppression, transparency, pride, reassurance seeking, etc.

So the model does not just receive flat memory lines. It also receives a compact live psychological/relationship state.

## 6. Emotion and Relationship Engine

Main file:

- `src-tauri/src/chat_manager/companion/mod.rs`

The emotion engine runs when a user message arrives.

The main entry point is:

- `update_state_for_user_message(...)`

### 6.1 State initialization

If the session has no `companionState`, the runtime initializes from:

- Soul baseline affect
- relationship defaults
- regulation style

So a fresh companion already has a personality profile before any memory is learned.

### 6.2 Decay model

Before applying the new turn, existing state decays toward baseline.

Examples:

- `felt` decays toward Soul baseline affect
- `expressed` decays toward Soul baseline affect
- `blocked` decays toward zero
- relationship tension decays down over time
- stability recovers gradually

The decay constant is centered around `DECAY_MINUTES = 45.0`, with modulation from `recovery_speed`.

### 6.3 Signal detection

The runtime runs local emotion classification on the new user message and converts the classifier output into:

- `SignalBundle.signals`
- `SignalBundle.delta`
- `SignalBundle.relationship_delta`
- `SignalBundle.confidence`

That signal bundle becomes the turn-level affective update.

### 6.4 Regulation model

The engine computes:

- new felt state
- new expressed state via `regulate_expressed(...)`
- new blocked state as `felt - expressed`
- momentum as a lerp toward the current delta

This is where regulation style matters:

- high suppression reduces outward expression
- high transparency increases visible emotion
- reassurance seeking and pride shape how need gets surfaced

### 6.5 Relationship update

The same turn also updates:

- closeness
- trust
- affection
- tension
- stability
- interaction count
- last interaction time

This means relationship state is not inferred only from memory later. It is actively maintained every turn.

## 7. Local ML Stack

Main files:

- `src-tauri/src/embedding/specs.rs`
- `src-tauri/src/embedding/emotion.rs`
- `src-tauri/src/embedding/ner.rs`
- `src-tauri/src/embedding/router.rs`
- `src-tauri/src/embedding/mod.rs`

The companion system uses four local model families:

1. sentence embeddings
2. emotion classifier
3. NER model
4. router classifier

## 7.1 Embeddings

Embedding model family:

- `Zeolit/lettuce-emb-512d-v1`
- `Zeolit/lettuce-emb-512d-v2`
- `Zeolit/lettuce-emb-512d-v3`

Used for:

- memory embeddings
- sentence embeddings during candidate routing
- prototype embedding cache
- retrieval similarity

## 7.2 Emotion classifier

Model source in code:

- `SamLowe/roberta-base-go_emotions-onnx`

Runtime:

- `src-tauri/src/embedding/emotion.rs`

Used for:

- detecting affective tone of user/sentence input
- strengthening relationship and milestone routing
- generating emotional snapshots
- feeding relationship signal intensity

## 7.3 NER

Model source in code:

- `Xenova/distilbert-base-multilingual-cased-ner-hrl`

Runtime:

- `src-tauri/src/embedding/ner.rs`

Used for:

- extracting people, places, orgs, dates
- improving profile/routine/episodic/milestone routing
- building canonical entity anchors
- improving long-range retrieval and contradiction checks

## 7.4 Router

Model source in code:

- `onnx-community/distilbert-base-uncased-mnli-ONNX`

Runtime:

- `src-tauri/src/embedding/router.rs`

Used for:

- sentence rememberability
- transient-vs-store-worthy routing
- category scoring via zero-shot hypotheses

The router is not used as a generative LLM. It is used as a local NLI-style classifier:

- premise = candidate sentence
- hypothesis = “this is a boundary / preference / profile / ...”

This gives a deterministic local classification signal without paying for LLM calls.

## 7.5 Bundle installation model

The embedding installer is now also the companion-model installer.

`install_bundle_complete` means all of these are present:

- embedding model
- companion emotion model
- companion NER model
- companion router model

The install plan is defined in `src-tauri/src/embedding/specs.rs`.

## 8. Companion Memory Pipeline

Main file:

- `src-tauri/src/chat_manager/companion/memory.rs`

This is the most important subsystem after prompting.

The generic dynamic-memory cycle is intercepted in `src-tauri/src/chat_manager/memory/flow.rs`.

If `companion::memory::is_enabled(...)` returns true, the engine redirects to:

- `companion::memory::process_turn(...)`

So companion mode does not go through the old summarizer + manager path.

## 8.1 High-level pipeline

The companion memory cycle is:

1. restore pinned-hot invariants
2. apply decay to current memory store
3. collect recent user/assistant messages
4. split messages into sentence chunks
5. run NER on each message
6. slice entities per sentence
7. canonicalize entities against previously known anchors
8. classify each sentence
9. build memory candidates
10. dedupe candidates
11. embed candidates
12. detect duplicates
13. detect contradictions / superseded facts
14. write new memory records
15. mark older records superseded
16. trim to capacity
17. enforce assistant retention caps
18. demote memories over token budget
19. persist session

## 8.2 Input window

The pipeline reads the most recent conversational turns with:

- `recent_conversation_messages(session, 6)`

It ignores non-user/non-assistant roles for candidate extraction.

This keeps write-time extraction local to recent turns while the full memory store persists across the entire session.

## 8.3 Sentence splitting

Messages are split by punctuation/newlines into `SentenceChunk`s.

Only chunks between roughly:

- 12 chars
- 220 chars

are considered.

This reduces noise from tiny fragments and long rambles.

## 8.4 Entity extraction and canonicalization

For each sentence:

- NER spans are extracted from the whole message
- spans overlapping the sentence are selected
- entities are canonicalized against previously stored anchors

Canonicalization logic includes:

- normalized surfaces
- alias overlap scoring
- per-label canonical keys like `per:john_smith`
- canonical-name selection favoring richer names

The result is a set of `MemoryEntityAnchor`s with:

- `label`
- `surface`
- `canonicalKey`
- `canonicalName`
- `confidence`

This prevents the memory system from fragmenting around slightly different names for the same entity.

## 8.5 Sentence routing

Each sentence is routed through three parallel signals:

1. embedding similarity against category prototypes
2. zero-shot router scores
3. emotion classifier scores

The supported companion categories are:

- `boundary`
- `preference`
- `profile`
- `routine`
- `episodic`
- `relationship`
- `milestone`
- `emotional_snapshot`

### Prototype layer

The system defines semantic prototypes like:

- a boundary sentence
- a profile fact sentence
- a milestone sentence

Each prototype has:

- target category
- expected speaker
- semantic description
- threshold
- pinned default

The prototype descriptions are embedded once and cached.

Every sentence embedding is compared against these prototype embeddings.

### Router layer

The local MNLI router scores:

- should this sentence be remembered?
- is it transient?
- how strongly does it match each category hypothesis?

### Emotion layer

The emotion classifier strengthens:

- relationship signals
- apology/repair signals
- milestone detection
- emotional snapshot generation

## 8.6 Structural guards

The system is not pure black-box ML. It uses a few lightweight structural gates:

- first-person checks
- second-person/shared-reference checks
- speaker/category compatibility
- entity-type hints

Examples:

- boundaries/preferences/profile/routine are usually user first-person
- relationship/milestone usually need first-person plus second-person/shared reference

This keeps routing robust without relying on brittle hardcoded phrases.

## 8.7 Assistant write policy

Assistant messages are intentionally restricted.

`assistant_policy_allows(...)` only permits assistant memories for categories like:

- episodic commitments
- relationship signals with enough emotional or structural weight
- milestones

Everything else is blocked.

This avoids polluting memory with generic assistant warmth or filler reassurance.

## 8.8 Candidate formatting

Candidates are stored as self-contained memory text such as:

- `User boundary: ...`
- `User preference: ...`
- `User fact: ...`
- `Shared plan or promise: ...`
- `Relationship signal: ...`
- `Relationship milestone: ...`

If entities are present, a `Key entities:` suffix is appended.

This makes memories understandable when retrieved later out of original transcript context.

## 8.9 Emotional snapshots

In addition to sentence-based candidates, the system can synthesize an `emotional_snapshot` memory from current live state.

It generates these only when the state is salient enough, for example:

- elevated tension
- notably warm/trusting state
- high reassurance need
- unusually visible vulnerability

This lets the prompt receive recent affective context even when no single sentence is a stable fact.

## 9. Importance Scoring

Companion memory does not use a single scalar only.

It computes:

- `importance_score`
- `persistence_importance`
- `prompt_importance`
- `volatility`

This logic is in `score_candidate_importance(...)`.

Category priors:

- boundary: very high persistence, low volatility
- milestone: maximum persistence/prompt, very low volatility
- profile: high persistence
- relationship: high prompt importance
- emotional snapshot: low persistence, very high volatility

Then local signals adjust those priors:

- router confidence
- semantic score
- emotional intensity
- entity count
- source role

Assistant-authored memories are penalized relative to user-authored ones.

## 10. Duplicate Detection and Contradiction Handling

This is one of the key improvements over the earlier memory system.

## 10.1 Duplicate detection

Before writing a new memory, the system checks:

- semantic duplicate detection against active memories
- same category
- same `factSignature`
- same polarity
- embedding similarity
- topic overlap
- entity overlap

If it is effectively the same fact, the candidate is skipped.

## 10.2 Fact signatures

Stable fact-like categories derive `factSignature` values.

Examples:

- boundary
- preference
- profile
- routine
- episodic
- milestone

These signatures are built from:

- normalized topic keys
- canonical entities when available

This gives the system a more stable identity for “what this memory is about” than raw text.

## 10.3 Polarity

For contradiction-prone categories, the system derives coarse polarity:

- `1` positive/affirmative
- `-1` negative/refusal/dislike/negation

That helps distinguish:

- “I like X”
- “I do not like X”

## 10.4 Supersession

If a new fact conflicts with an older active fact:

- the new one is written
- the old one is marked with `supersededBy`
- the old one gets `supersededAt`
- the old one is forced cold
- its importance is pushed down

Importantly:

- assistant-authored memories cannot supersede user-authored facts
- system-generated snapshots cannot supersede memories

This prevents low-authority sources from overwriting user truth.

## 11. Retention, Decay, and Retrieval

## 11.1 Retrieval

Companion retrieval is not generic cosine similarity only.

`select_relevant_memories(...)` combines:

- query embedding cosine similarity
- keyword overlap
- importance score
- prompt importance
- persistence importance
- volatility penalty
- access count
- recency bonus
- source-role weighting
- category-specific boosts
- current relationship state

This is why relationship memories remain prominent in companion chats even if they are not the most lexically similar.

## 11.2 Prompt retention

When building `{{key_memories}}`, the system uses `prompt_retention_score(...)`.

This score strongly weights:

- `prompt_importance`
- `persistence_importance`
- category priority
- recency
- pinning
- source role

So prompt injection is more selective than just “all hot memories”.

## 11.3 Decay

`apply_companion_decay(...)` reduces `importance_score` over time using:

- volatility
- persistence importance
- prompt importance

Volatile memories cool faster.
Stable memories hold longer.

Pinned memories do not decay normally.

## 11.4 Hot/cold demotion

The system still respects the dynamic-memory hot-token budget.

After writing:

- low-ranked memories are demoted cold
- pinned memories are kept hot
- oversized stores are trimmed by retention score

## 11.5 Assistant retention limits

The system also enforces hard caps:

- max hot assistant memories overall
- max hot assistant relationship/episodic memories

This is a deliberate guardrail so the companion does not become dominated by its own previous language.

## 12. Prompt-Time Memory Injection

Companion prompt injection differs from regular dynamic memory.

`prompt_memory_lines(session, character)`:

- filters to active memories
- ignores superseded memories
- prefers hot or pinned memories
- scores by prompt retention
- returns only the top subset

The prompt engine uses this for companion chats instead of dumping the generic memory store logic.

So prompt state is built from:

- live emotional and relationship state
- Soul and style notes
- selected key memories
- normal chat context

That gives the model both:

- durable relationship facts
- immediate emotional context

## 13. Frontend Architecture

## 13.1 Character editing

Main files:

- `src/ui/pages/characters/components/InteractionModeSelector.tsx`
- `src/ui/pages/characters/components/CompanionSoulEditor.tsx`
- `src/ui/pages/characters/components/DescriptionStep.tsx`
- `src/ui/pages/characters/EditCharacter.tsx`

Character authoring now supports:

- roleplay vs companion mode
- Soul editing
- relationship defaults
- companion memory config
- companion prompt template id

The Soul editor is the authored control plane for the companion system.

## 13.2 Companion chat routes

Main files:

- `src/ui/navigation.ts`
- `src/App.tsx`

Routes:

- `/chat/:characterId/companion/memories`
- `/chat/:characterId/companion/relationship`

The route helpers branch from the generic memory route so companion chats do not land in the old page.

## 13.3 Companion UI model layer

Main file:

- `src/ui/pages/chats/companionUi.tsx`

This file centralizes frontend companion normalization:

- `useCompanionSessionData(...)`
- `buildCompanionMemoryItems(...)`
- category ordering
- display helpers
- companion-chat detection

It adapts the raw session model into UI-friendly companion memory cards.

## 13.4 Companion Memory page

Main file:

- `src/ui/pages/chats/CompanionMemoryPage.tsx`

Responsibilities:

- show current relationship/emotional snapshot
- show counts for active/superseded/pinned memory
- manual add/edit/delete/pin/warm/cool operations
- search/filter/group memory records by companion category
- display canonical entities and supersession metadata

This page is the inspection surface for the actual companion memory runtime.

## 13.5 Companion Relationship page

Main file:

- `src/ui/pages/chats/CompanionRelationshipPage.tsx`

Responsibilities:

- show current relationship metrics against authored defaults
- visualize felt/expressed/blocked/momentum vectors
- show active drivers
- summarize Soul text
- show a recent relationship timeline derived from relationship/milestone/snapshot memory

This page is effectively the introspection surface for the emotional engine.

## 14. Why This Architecture Is Different From the Old Dynamic Memory

The generic dynamic-memory system was centered on:

- conversation summarization
- tool events
- memory CRUD
- general-purpose retrieval

The companion system changes the abstraction.

It is built around:

- authored identity (`Soul`)
- live emotional regulation
- relationship state
- companion-specific memory semantics
- contradiction-safe stable facts
- local ML classification/routing

That is a fundamentally different model.

The old memory system answered:

- “what should I remember from the chat?”

The companion system answers:

- “what kind of relationship is forming?”
- “what stable truths about this person matter?”
- “what emotional context is active right now?”
- “which older facts are still valid, and which have been superseded?”

## 15. Current Strengths

The current architecture is strong in these areas:

- clear split between roleplay and companion chat modes
- dedicated prompt path for companion replies
- explicit Soul model
- live emotional and relationship state
- local ONNX emotion/NER/router stack
- semantic + structured memory extraction
- canonical entity support
- contradiction and supersession handling
- multi-axis retention scoring
- assistant-memory restrictions
- dedicated companion UI surfaces

## 16. Current Gaps

Still missing or deferred:

- historical backfill for very old chats
- dedicated trained memory-router model beyond current zero-shot MNLI router
- stronger entity linking beyond local alias heuristics
- dedicated user controls like pause/reset relationship/memory from in-chat
- more advanced timeline explanations
- companion-specific memory privacy/category controls

These are extensions, not blockers for the current architecture.

## 17. End-to-End Flow Summary

An end-to-end companion turn currently works like this:

1. A companion-mode session is created.
2. The session uses the companion prompt template path.
3. A user message arrives.
4. The emotion engine updates `session.companionState`.
5. The dynamic-memory dispatcher detects companion mode and redirects to the companion memory pipeline.
6. Recent turns are sentence-split and processed through embeddings, router, emotion classifier, and NER.
7. Stable candidate memories are created, deduped, possibly supersede older facts, and are stored as enriched `MemoryEmbedding` records.
8. The reply path retrieves companion-relevant memories with companion-specific ranking.
9. The prompt engine injects:
   - companion rules
   - Soul text
   - emotional/relationship state
   - companion memory lines
10. The model generates the next reply as a relationship-continuous companion, not a generic roleplay narrator.

That is the current companion architecture.
