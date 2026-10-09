# English Lecture Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process English YouTube lectures into evidence-linked Korean notes while preserving and displaying aligned English captions and Korean translations.

**Architecture:** Extend the local Codex/Deno workflow with verified English subtitle selection, whole-lecture context, conservative correction and one translation per source segment. A distinct JSON 2.0 contract carries bilingual segments; the server and viewer continue to accept Korean JSON 1.0 and the public catalog from release stage 1.

**Tech Stack:** Windows Codex plugin, Deno 2.5.6/TypeScript, pinned yt-dlp, JSON Schema/Ajv, Python 3.12/FastAPI/jsonschema, PostgreSQL 17, Playwright 1.64.0.

**Spec:** `docs/superpowers/specs/2026-10-09-lecture-viewer-catalog-english-design.md` (approved 2026-10-09), especially “영어 자막·번역 처리와 JSON 계약”. Start after `docs/superpowers/plans/2026-10-09-lecture-viewer-catalog.md` passes its release gate.

## Global Constraints

- This plan is release stage 2. Korean JSON 1.0, previous share URLs, quota, 90-day expiry, public-list opt-in and the 10 MiB upload limit remain valid.
- English JSON uses `schema_version: "2.0"`, `lecture.caption_language: "en"`, `caption_source: "manual" | "auto"`, `translation_language: "ko"`, and a nonempty `translation_ko` for every segment.
- Prefer original human-provided English subtitles, then original English auto subtitles. Never silently use an auto-translated English track from another source language.
- No video/audio download, speech-to-text service, external translation API key or web URL intake. Keep the 3-hour maximum and Windows portable-tool bootstrap.
- Read all chunks before correction or translation. Preserve every original segment index and timestamp; corrections require evidence and translations cover each segment exactly once.
- At the release gate, present local and CI evidence for user approval before pushing a public plugin release or deploying to Railway.
- Implement on a feature branch and run GitHub CI through a pull request; merging to `main` triggers Railway, so merge only after deployment approval.

## Review Focus

- A video whose native metadata says another language but advertises auto-translated English captions must stop, not be labeled original English; `test_reject_translated_english_track` in Task 2.
- A human English subtitle available only as VTT must parse without losing cue order, timestamps or HTML-like text; `test_manual_vtt_fallback` in Task 2.
- Missing, repeated or out-of-chunk translation indices must fail before upload; `test_translation_coverage` in Task 4.
- A previously saved Korean JSON 1.0 document and its share URL must still validate and render; `test_legacy_korean_contract` in Task 1 and `legacy_korean_viewer_survives` in Task 5.
- Search for mixed-case English, Korean and punctuation must highlight the correct field without executing caption text; `bilingual_search_highlights_both_languages` in Task 5.

## File Map

- New `plugins/lecture-notes/schema/lecture-v2.schema.json`, existing `lecture.schema.json`, `scripts/types.ts`, `server/app/contract.py`, `Dockerfile`: dual-version contract, shared across plugin and server.
- `plugins/lecture-notes/scripts/captions.ts`, new `scripts/vtt.ts`, `tests/fetch.test.ts`, new `tests/vtt.test.ts`: original-track selection and subtitle normalization.
- `plugins/lecture-notes/scripts/cli.ts`, `tests/cli.test.ts`: language-aware fetch/prepare, durable source manifest, resumable runs.
- `plugins/lecture-notes/scripts/assemble.ts`, `tests/assemble.test.ts`, `tests/fixtures/valid-english-lecture.json`: one-to-one translation assembly, grounded notes and glossary.
- `plugins/lecture-notes/skills/lecture-notes/SKILL.md`, `README.md`: whole-context English correction/translation instructions and uncertainty reporting.
- `server/app/templates/lecture.html`, `server/app/static/lecture.js`, `server/e2e/lecture.spec.ts`, `server/e2e/fixture_server.py`, `server/tests/test_viewer.py`: bilingual display and search.
- `.github/workflows/ci.yml`, `server/tests/test_contract.py`, `server/tests/test_ingest.py`, `plugins/lecture-notes/tests/*.test.ts`: compatibility and release checks.

---

### Task 1: Dual-Version JSON Contract

**Files:** Create `plugins/lecture-notes/schema/lecture-v2.schema.json`, `plugins/lecture-notes/tests/fixtures/valid-english-lecture.json`; modify `plugins/lecture-notes/scripts/types.ts`, `plugins/lecture-notes/tests/contract.test.ts`, `server/app/contract.py`, `server/tests/test_contract.py`, `Dockerfile`.

**Interfaces:** Keep `validateLecture(doc: unknown): LectureDocument` and `validate_document(doc: dict) -> None`. `LectureDocument` becomes `KoreanLectureDocument | EnglishLectureDocument`; `EnglishLectureDocument` has the spec's v2 lecture metadata and `TranslatedSegment extends Segment` with `translation_ko: string`. Dispatch on `schema_version` before schema validation to preserve `/schema_version` errors. Keep v1 schema unchanged; package both files in Docker and the plugin.

- [ ] **Step 1: Write failing contract tests.** `valid_english_lecture` accepts a four-segment v2 fixture with complete outline and references. `missing_translation`, `bad_caption_source`, `wrong_translation_language` and `unsupported_version` assert path-specific errors in Deno and Python. `test_legacy_korean_contract` asserts the existing fixture remains valid and unchanged.
- [ ] **Step 2: Run tests red.** `deno test --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/contract.test.ts` and `python -m pytest -q server/tests/test_contract.py`; expect v2 cases to fail.
- [ ] **Step 3: Implement the contract.** Add the v2 schema with required `translation_ko`, `translation_language: "ko"`, `caption_language: "en"`, `caption_source` enum `manual|auto`, and the unchanged cross-reference/timing rules. Select v1 or v2 validator by version and keep detailed paths. Update Docker `COPY` to include both schemas.
- [ ] **Step 4: Run tests green.** Run Step 2 plus `docker build -t lecture-notes-server .`; expect both contract suites and build to pass.
- [ ] **Step 5: Commit.** `git add plugins/lecture-notes/schema plugins/lecture-notes/scripts/types.ts plugins/lecture-notes/tests server/app/contract.py server/tests/test_contract.py Dockerfile && git commit -m "feat: validate bilingual lecture documents"`.

### Task 2: Verified English Caption Selection and VTT Parser

**Files:** Modify `plugins/lecture-notes/scripts/captions.ts`, `plugins/lecture-notes/tests/fetch.test.ts`; create `plugins/lecture-notes/scripts/vtt.ts`, `plugins/lecture-notes/tests/vtt.test.ts`.

**Interfaces:** Export `selectCaptionTrack(info: unknown, requestedLanguage: "ko" | "en" | "auto"): CaptionTrack`, where `CaptionTrack` contains `{ language: "ko" | "en"; source: "manual" | "auto"; format: "json3" | "vtt" }`. Export `parseVtt(text: string): Segment[]`. Define `ToolPaths = {deno: string; ytdlp: string}` and extend `fetchCaption(videoId: string, workDir: string, toolPaths: ToolPaths, runner: CommandRunner = runCommand, requestedLanguage: "ko" | "en" | "auto" = "auto"): Promise<{captionPath: string; infoPath: string; track: CaptionTrack}>`; `CommandRunner` returns `{code, stdout, stderr}` so structured metadata can be inspected without downloading media.

- [ ] **Step 1: Write failing selection/parser tests.** `test_manual_english_precedes_auto`, `test_auto_english_fallback`, `test_reject_translated_english_track`, `test_ambiguous_native_language`, `test_no_english_caption` and `test_manual_vtt_fallback` use stubbed metadata/commands. VTT tests include multiple cues, overlapping cues, multiline text, entities and HTML-like payloads; assert monotonic 1-based segments with preserved content. Existing Korean auto-caption test must still pass.
- [ ] **Step 2: Run tests red.** `deno test --allow-read --allow-write --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/fetch.test.ts plugins/lecture-notes/tests/vtt.test.ts`; expect missing selector/parser failures.
- [ ] **Step 3: Implement selection and parsing.** Inspect structured yt-dlp metadata (`subtitles`, `automatic_captions`, native-language field) before requesting one selected track. For native `en`, choose manual before auto and JSON3 before VTT; reject a contradictory native language even if an English translated track exists. In `auto` mode, ambiguous native metadata raises a named error so the skill asks for a language; an explicit `en` or `ko` confirmation may resolve only missing metadata. For native `ko`, preserve the Korean auto path. Normalize VTT to the same `Segment` shape as `parseJson3`; reject malformed or empty cues. Keep `--skip-download` and `--no-playlist`.
- [ ] **Step 4: Run tests green.** Run Step 2 and `deno check --config plugins/lecture-notes/deno.json plugins/lecture-notes/scripts/cli.ts`; expect success.
- [ ] **Step 5: Commit.** `git add plugins/lecture-notes/scripts/captions.ts plugins/lecture-notes/scripts/vtt.ts plugins/lecture-notes/tests && git commit -m "feat: select original English captions"`.

### Task 3: Resumable English Fetch and Preparation

**Files:** Modify `plugins/lecture-notes/scripts/cli.ts`, `plugins/lecture-notes/tests/cli.test.ts`, `plugins/lecture-notes/tests/fetch.test.ts`.

**Interfaces:** `fetchRun(url: string, runDir: string, workspace: string, requestedLanguage: "ko" | "en" | "auto" = "auto") -> Promise<Source>` writes `source.json` with selected language, format and source. The CLI accepts `fetch <url> <run-dir> <workspace> [ko|en|auto]`. `prepareRun(runDir: string) -> Promise<Chunk[]>` parses the saved track and writes the existing `segments.json` and numbered chunks.

- [ ] **Step 1: Write failing CLI tests.** `test_english_fetch_prepare_resume` asserts an English metadata/caption stub yields v2 source, time-aligned segments and stable files on rerun. `test_mismatched_resume_source` rejects changed language/track or video ID in the same run directory. `test_korean_fetch_still_works` preserves the v1 flow. Assert no video/audio file is written.
- [ ] **Step 2: Run tests red.** `deno test --allow-read --allow-write --allow-run --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/cli.test.ts`; expect English branch assertions to fail.
- [ ] **Step 3: Implement source and prepare branching.** Persist chosen `caption_language`, `caption_source`, format and original caption filename once; read this manifest for every resume. Route JSON3 and VTT through their parsers, preserve 1-based monotonic timing and the existing five-second metadata-tail rule. Do not reselect a track after a partial run.
- [ ] **Step 4: Run tests green.** Run Step 2 and `deno check --config plugins/lecture-notes/deno.json plugins/lecture-notes/scripts/cli.ts`; expect success.
- [ ] **Step 5: Commit.** `git add plugins/lecture-notes/scripts/cli.ts plugins/lecture-notes/tests && git commit -m "feat: prepare resumable English lecture runs"`.

### Task 4: Translation Assembly and Whole-Context Gate

**Files:** Modify `plugins/lecture-notes/scripts/assemble.ts`, `plugins/lecture-notes/scripts/cli.ts`, `plugins/lecture-notes/tests/assemble.test.ts`, `plugins/lecture-notes/tests/cli.test.ts`.

**Interfaces:** English runs read `translations/<chunk_idx>.json` containing `[{"segment_idx": 1, "translation_ko": "..."}]`. `assembleEnglishLecture(inputs: EnglishAssemblyInputs): EnglishLectureDocument` applies evidenced corrections, requires exactly one nonempty translation per segment, derives timestamps/references from the original English segment order and passes `validateLecture`. `assembleRun(runDir)` chooses v1 or v2 from `source.json`.

- [ ] **Step 1: Write failing assembly tests.** `test_translation_coverage` rejects missing, duplicate, out-of-range, out-of-chunk and blank translations. `test_english_assembly_uses_context_and_preserves_times` requires all context parts and whole-lecture brief before correction or translation, then checks English text, Korean translation, chapter and evidence times. Existing Korean assembly tests remain green.
- [ ] **Step 2: Run tests red.** `deno test --allow-read --allow-write --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/assemble.test.ts plugins/lecture-notes/tests/cli.test.ts`; expect new v2 cases to fail.
- [ ] **Step 3: Implement v2 assembly.** Reuse the existing exact, nonoverlapping correction and range-time derivation logic. Read each translation file after the whole-context gate; compare its indices with that chunk's editable range and reject any gap or extra. Preserve local raw captions and existing `lecture.json` write-once/idempotent rules.
- [ ] **Step 4: Run tests green.** Run Step 2 and the full `deno test --allow-read --allow-write --allow-run --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/*.test.ts`; expect success.
- [ ] **Step 5: Commit.** `git add plugins/lecture-notes/scripts plugins/lecture-notes/tests && git commit -m "feat: assemble aligned English and Korean transcripts"`.

### Task 5: Bilingual Viewer and Plugin Judgment Instructions

**Files:** Modify `server/app/templates/lecture.html`, `server/app/static/lecture.js`, `server/e2e/lecture.spec.ts`, `server/e2e/fixture_server.py`, `server/tests/test_viewer.py`, `plugins/lecture-notes/skills/lecture-notes/SKILL.md`, `README.md`, `plugins/lecture-notes/plugin.json`.

**Interfaces:** A v2 transcript row shows corrected English `segment.text` and `segment.translation_ko` under the same time button. The existing `#transcript-search` filters/highlights both fields. The skill writes complete `translations/<chunk_idx>.json` after all context files, reports uncertainty, and uploads only validated `lecture.json` using the public-list signal from release stage 1.

- [ ] **Step 1: Write failing viewer and skill-workflow tests.** `bilingual_search_highlights_both_languages` searches English, Korean and punctuation, checks corresponding `<mark>` elements and escaping. `legacy_korean_viewer_survives` loads v1 and asserts one transcript line per segment with all existing seek behavior. A fixture-run test asserts `assemble` refuses missing translation files before the skill can upload.
- [ ] **Step 2: Run tests red.** From `server/`, run `npm run test:e2e`; from repo root run `python -m pytest -q server/tests/test_viewer.py` and the relevant Deno CLI test; expect v2 display/workflow assertions to fail.
- [ ] **Step 3: Implement bilingual presentation and guidance.** Branch row markup on `schema_version` while preserving Jinja escaping and seek buttons. Reuse the safe highlight helper for both language fields. Update the skill with manual→auto selection, full-context English correction, 1:1 translation, Korean note/glossary grounding and uncertainty reporting. Update README and bump the plugin version from 0.2.0 to 0.3.0.
- [ ] **Step 4: Run tests green.** Run Step 2, full Python and Deno suites, `deno fmt --check plugins/lecture-notes/scripts plugins/lecture-notes/tests`, and `git diff --check`; expect success.
- [ ] **Step 5: Commit.** `git add server/app/templates/lecture.html server/app/static/lecture.js server/e2e server/tests plugins/lecture-notes/skills README.md plugins/lecture-notes/plugin.json && git commit -m "feat: display bilingual lecture transcripts"`.

### Task 6: Real English Lecture Acceptance Run

**Files:** Use ignored `.lecture-notes/runs/<english-sample-id>/` for source, context, translation and final JSON; modify tests or guidance only if the run exposes a reproducible defect.

**Interfaces:** Run the working-tree plugin CLI steps `doctor`, `fetch`, `prepare`, `assemble`, then upload after deployment approval. A single public English lecture of at most 3 hours serves as the sample; keep its URL, caption source, segment count, uncertainties and local JSON path in the task evidence.

- [ ] **Step 1: Choose and record one public English lecture with source captions.** Do a text-only fetch and assert the track is native English and correctly labeled manual or auto. Reject unsuitable samples before authoring notes.
- [ ] **Step 2: Read every chunk, save all context parts and the whole-lecture brief, then write evidenced corrections, one Korean translation per segment, Korean outline, summary and glossary.** Keep raw caption files immutable.
- [ ] **Step 3: Assemble and verify locally.** Run the working-tree CLI `assemble` (which calls `validateLecture`), then `python -c 'import json,sys; from server.app.contract import validate_document; validate_document(json.load(open(sys.argv[1], encoding="utf-8")))' <run-dir>/lecture.json`; assert each source segment has one translation and all references/times are valid. Run `python -m pytest -q server/tests`, the full Deno test command from Task 4, and `npm --prefix server run test:e2e` locally, then require the Windows bootstrap, Docker and PostgreSQL CI jobs on a feature-branch pull request. Correct reproducible defects with a failing test first.
- [ ] **Step 4: Commit any required repairs and report the sample evidence.** A semantic read-through checks translated terminology and the English/Korean display; no upload or public release occurs before the user approves the release gate.

## Stage 2 Release Gate

- [ ] Present the real English sample, unchanged legacy Korean result, automated test output, CI run and proposed release diff to the user for **deployment approval**.
- [ ] After approval, merge the tested branch to `main`, wait for Railway success, upload the already validated English JSON once, verify bilingual page and catalog entry, publish the 0.3.0 GitHub ZIP, and update the local marketplace install.
