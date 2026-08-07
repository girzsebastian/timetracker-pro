# TimeTracker Pro — Final Build Decision Record

## 1. Winning Decisions

**stack_and_db** — *3/3 ballots.*
Node 20 + Fastify + better-sqlite3, one process serving the vanilla dark SPA as static files plus a REST `/api`. Single `data/timetracker.db` (WAL on, schema on boot, no ORM). Reuse the existing export/import JSON (`app.js:169`) as the one-time localStorage→SQLite migration — **test the round-trip before cutover**. Build one **server-side `actions.js` module** (validate args, resolve names→IDs, perform write) that BOTH REST routes and `/api/command` dispatch through. Client keeps `S` authoritative, renders optimistically, POSTs deltas with rollback-on-failure.

**local_ai** — *3/3 ballots.*
Ollama, server-side only, **ONE model qwen2.5:7b-instruct** (3b fallback) for both command parsing and report prose. Native `/api/chat` with a strict JSON Schema in the `format` field (GBNF grammar-constrained), temp 0–0.2. Model **never emits IDs** — server does diacritic-normalized fuzzy resolution. 14B is opt-in for reports only. Replace the Anthropic key field with a model picker from `/api/tags`. `start.sh` verifies Ollama, pulls 7B on first run with progress, fails loud otherwise.

**voice_command_ux** — *3/3 ballots.*
Propose-then-confirm command console; Wispr Flow (primary), Web Speech ro-RO (convenience), and typing all funnel into one focused field. **Explicit commit** = visible Execute button + "dă-i drumul"/Enter — **no pause-based auto-submit**. Server resolves names→IDs AND client+hint→concrete `projectId`, returning an **ambiguous** state when a client has multiple projects and no hint. Single-intent is the reliable contract; compound is review-before-commit.

**filtering_and_pdf** — *3/3 ballots.*
One shared filter object `{clientId, projectId, personId, tags[], from, to, text}` driving Entries, Dashboard, Report AND PDF, filtered via parameterized SQL on `GET /api/entries`, writable by voice `set_filter`. **PDF default = pdfmake** (pure JS, no Chromium) producing a real file at `GET /api/export.pdf`: KPIs, per-client hours-vs-package, per-person distribution, full day-grouped log, tag breakdown, LLM narrative. Playwright strictly opt-in.

**design** — *3/3 ballots.*
Keep dark tokens, glyphs, Romanian copy verbatim — additive only. Add: Cmd+K console with legible state machine (Idle→Listening→Thinking→Preview→Executed), resolved preview chips, persistent voice/audit log, sticky filter bar, Ollama status dot, local-AI settings block. One deliberate departure: a **light "paper" PDF theme**. Stay vanilla JS.

## 2. Local-AI Command Contract

Spoken text → `POST /api/command {text, context}` where `context` carries the live catalog (client/project/person names+IDs, active filter, active timer). Ollama returns grammar-constrained JSON:

```json
{
  "reply": "Pornesc cronometru pentru Ana pe Suport & modificări",
  "actions": [
    { "action": "start_timer",
      "args": { "clientName": "Alvanda", "projectHint": "suport",
                "personName": "Ana", "tags": ["bug"] } }
  ]
}
```

**Action verbs (fixed enum):** `start_timer`, `stop_timer`, `add_entry`, `create_client`, `create_project`, `create_person`, `set_filter`, `generate_report`, `export_pdf`, `navigate`, `delete_entry`, `delete_client`.

**Server pipeline:** validate shape → fuzzy-resolve every name to a DB row → resolve `clientName`+`projectHint` to one `projectId` (or emit `{status:"ambiguous", candidates:[...]}`) → reject unknown IDs → run create-dedupe similarity check → return resolved preview objects.

**Safety ladder (data-changing rule):**
- **Reads** (`set_filter`, `navigate`, `generate_report`) — auto-execute.
- **All writes** incl. every `create_*` and `add_entry` — render a resolved preview chip; require explicit confirm (tap or "dă-i drumul"); every write drops a 5s Undo.
- **Destructive/cascade** (`delete_entry`, `delete_client` which wipes projects — `app.js:160`) — second stronger confirm, no auto-execute on undo timer alone.

## 3. Flagship "dă-i drumul" Demo Script

1. Owner hits **Cmd+K**; console shows **Idle** with mic + hint.
2. Owner taps mic (or dictates via Wispr): *"pornește cronometru pentru mentenanță la Alvanda, persoana Ana, tag bug"*. Console shows **Listening** with streaming interim transcript.
3. **Thinking** dots; local qwen2.5:7b returns a grammar-constrained `start_timer` plan.
4. Server resolves Alvanda + "mentenanță/suport" → **Suport & modificări**, Ana → **Ana Pop**. **Preview** chip renders the resolved client / project / person / tag.
5. Owner says **"dă-i drumul"** → the persistent timer bar starts ticking, chip flips to **Executed**, toast + ro-RO TTS confirms, entry appears in the voice log.
6. Second beat: *"filtrează pe Alvanda luna asta și exportă PDF"* → `set_filter` auto-fires (dashboard/entries update live), `export_pdf` streams a branded file that downloads hands-free. Fully offline, zero API cost, real DB writes.

## 4. Build Checklist (by impact)

1. **Server `actions.js` registry** — extract every DOM-coupled handler (`app.js:121–154`) into arg-taking functions. *Hard prerequisite; everything else depends on it.*
2. **Fastify + better-sqlite3 backend** — schema mirroring `S`, REST routes calling `actions.js`, WAL, boot migration.
3. **localStorage→SQLite import** — reuse existing backup JSON; verify round-trip against a real backup.
4. **Client persistence swap** — optimistic `S` + background POST + rollback.
5. **Ollama integration** — one 7B model, `format`-constrained command endpoint + streamed report endpoint.
6. **Fuzzy resolver** — diacritic-normalized name→ID, client→projectId disambiguation, create-dedupe.
7. **Voice console** — one focused field, explicit commit, state machine, preview chips, safety ladder, undo, voice log.
8. **Shared filter object** — server WHERE builder + filter bar UI, wired to `set_filter`.
9. **pdfmake export** — light print theme, "everything" report at `/api/export.pdf`.
10. **`start.sh`** — detect Ollama, pull model with progress, boot Fastify; honest one-command README.

## 5. Explicitly Rejected

- **OpenAI-style tool-calling** on 7B (P1) — flakes to `tool_calls=null`; grammar-constrained `format` chosen instead.
- **Two-model setup** (P1: 7b+llama3.1:8b) and **14B default** (P4) — evict/reload thrash and >16GB laptop budget kill the voice loop.
- **Pause-based auto-submit** (P2/P3) — fires half-commands with Wispr's chunked keystrokes.
- **Auto-executing `create_*`** (P2) — mistranscription spawns duplicate clients, corrupting hours-vs-package math.
- **Playwright/Puppeteer Chromium as default** (P1/P3/P4) — 150–300MB download violates low-ops/one-command; opt-in only.
- **window.print() as blessed PDF path** (P2) — OS dialog can't complete a hands-free voice export.
- **Client-side actions registry** (P4 original) — relocated to server so voice can do nothing the API can't.
- **Model-reported `confidence` gating** (P3/P4) — uncalibrated; gate on server unique-entity resolution instead.
- **Any frontend-framework rewrite** — adds ops/risk for zero visible gain.