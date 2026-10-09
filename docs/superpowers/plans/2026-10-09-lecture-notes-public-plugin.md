# Public Lecture Notes Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Windows Codex user turn a Korean YouTube lecture into a timestamped `lecture.json` and an unlisted Railway page without signup or an API key.

**Architecture:** A portable Codex plugin runs Deno scripts and Codex judgment locally; the server never fetches YouTube or invokes an LLM. A shared JSON schema connects that plugin to one FastAPI/Railway service backed by PostgreSQL. The public GitHub repository contains the plugin marketplace catalog and the server deployment source.

**Tech Stack:** Codex skill, PowerShell bootstrap, Deno/TypeScript, official yt-dlp Windows executable, JSON Schema 2020-12, FastAPI, Jinja2, PostgreSQL/psycopg, pytest, Railway, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-09-youtube-lecture-plugin-design.md`

## Global Constraints

- After each numbered task, show the user the changed files, a concise diff summary, and verification results. Wait for explicit approval before starting the next task.
- First release: Windows Codex desktop, Korean auto-generated captions, lectures up to 3 hours.
- Development and CI have Deno 2.3+, Python 3.12+, and pytest available; end users get the portable tools through Task 3's bootstrap.
- No user account, service API key, admin install, video download/edit, audio transcription, or web URL submission.
- First-run tools: Deno and official yt-dlp in the workspace cache, pinned versions and SHA-256 verified before execution. Codex may request download/execution approval.
- Upload: anonymous HTTPS JSON only, maximum 10 MiB; per client IP 3/hour and 10/day; service-wide 200/day. Same `run_id` and canonically identical JSON return the existing result before quota counting.
- Result: unlisted random share URL, no public listing, 90-day retention, expired links return 404.
- The plugin package must remain usable from `plugins/lecture-notes/` alone. OpenAI directory submission is later and subject to separate review.
- MIT is the proposed source license; confirm before public GitHub publication.

## Review Focus

- A `youtu.be` or `youtube.com/watch` link with extra parameters resolves to the same video ID; lookalike hosts and malformed IDs fail before network access (Task 3).
- An empty or malformed JSON3 caption event fails with a clear caption error, while overlapping valid events keep monotonic segment times (Task 4).
- An unsupported `schema_version` fails on both client and server rather than being silently stored (Tasks 1 and 5).
- A reused `run_id` with changed content returns 409, while a canonically identical retry returns the same URL without using quota (Task 2).
- A forged forwarding header cannot bypass limits; transcript text containing HTML renders as text rather than script (Tasks 2 and 6).

## File Map

- `plugins/lecture-notes/plugin.json`: portable plugin identity and Codex listing metadata.
- `plugins/lecture-notes/skills/lecture-notes/SKILL.md`: whole-lecture context pass, grounded correction, and bounded judgment prompts.
- `plugins/lecture-notes/schema/lecture.schema.json`: one source of truth for client and server.
- `plugins/lecture-notes/deno.json`: pinned local script dependencies and permissions.
- `plugins/lecture-notes/tools/bootstrap.ps1`, `tools.lock.json`: Windows tool discovery, verified portable downloads.
- `plugins/lecture-notes/scripts/url.ts`, `captions.ts`, `chunk.ts`, `assemble.ts`, `upload.ts`, `cli.ts`: deterministic local stages and command entry point.
- `plugins/lecture-notes/scripts/types.ts`: shared local JSON shapes.
- `plugins/lecture-notes/tests/*.test.ts`: local parser, validation, assembly, and upload tests.
- `server/app/main.py`, `contract.py`, `models.py`, `repository.py`, `rate_limit.py`, `views.py`: API composition, contract validation, database persistence, quotas, and view routes.
- `server/app/templates/lecture.html`, `server/app/static/lecture.js`, `lecture.css`: share page.
- `server/migrations/001_init.sql`, `server/tests/*.py`, `server/e2e/lecture.spec.ts`, `server/package.json`, `server/requirements.txt`: persistence, browser behavior, and tests.
- `Dockerfile`, `.agents/plugins/marketplace.json`, `.github/workflows/ci.yml`, `README.md`, `LICENSE`, `.gitignore`: deployment and public distribution.

---

### Task 1: JSON Contract and Examples

**Files:** Create `plugins/lecture-notes/schema/lecture.schema.json`, `plugins/lecture-notes/deno.json`, `plugins/lecture-notes/scripts/types.ts`, `plugins/lecture-notes/tests/fixtures/valid-lecture.json`, `plugins/lecture-notes/tests/contract.test.ts`, `server/app/contract.py`, `server/requirements.txt`, `server/tests/test_contract.py`.

**Interfaces:** `LectureDocument` has `schema_version: "1.0"`, UUID `run_id`, `lecture`, ordered `segments`, `outline.chapters[].children[]`, `summary_note`, and `glossary`. Segments use `idx/start_sec/end_sec/text`; all referenced indices and times point to these segments. Export `validateLecture(doc: unknown): LectureDocument` from `scripts/types.ts` and `validate_document(doc: dict) -> None` from `server/app/contract.py`; both throw a path-specific error on schema or cross-reference failure and load the same schema file.

- [ ] **Step 1: Write failing contract tests.** `valid_lecture` asserts `validateLecture(fixture).schema_version === "1.0"` and `validate_document(fixture) is None`; `missing_note`, `unsupported_version`, `chapter_gap`, and `glossary_out_of_range` assert path-specific errors.
- [ ] **Step 2: Run them red.** `deno test --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/contract.test.ts` and `pytest server/tests/test_contract.py -q` must fail because the contract is absent.
- [ ] **Step 3: Add the schema, fixture, types, and both validators.** Use a pinned Ajv 2020 dependency in `plugins/lecture-notes/deno.json`; validate chapter coverage and reference integrity after schema validation. Put Python `jsonschema` and pytest in `server/requirements.txt`; the Python validator reads the same schema file.
- [ ] **Step 4: Run both test files green** and manually inspect the example for one chapter with two children and a key point and glossary term anchored to existing segment numbers.
- [ ] **Step 5: Commit** the contract and tests: `feat: define lecture JSON contract`.

### Task 2: Anonymous Ingest and Persistence

**Files:** Create `server/app/main.py`, `server/app/models.py`, `server/app/repository.py`, `server/app/rate_limit.py`, `server/migrations/001_init.sql`, `server/tests/test_ingest.py`; modify `server/requirements.txt`.

**Interfaces:** `POST /api/lectures` consumes `LectureDocument` and returns `{share_url, expires_at}`. `Repository.insert_or_get(doc: dict, client_key: str) -> SavedLecture` is transactionally idempotent by `run_id` and body SHA-256. `Repository.get_active(share_token: str) -> SavedLecture | None`; `Repository.delete_expired(now: datetime) -> int`. `rate_limit.client_key(ip: str, secret: bytes, day: date) -> str` stores only a keyed hash. Share tokens come from a cryptographic random source.

- [ ] **Step 1: Write failing API tests.** `test_valid_upload` asserts status 201 and a share URL; `test_too_large` asserts 413 above 10 MiB; `test_unsupported_schema` asserts 422; `test_idempotent_retry` asserts an unchanged URL and quota count; `test_run_id_conflict` asserts 409. Limit tests assert 429 after the exact 3/hour, 10/day/IP, and 200/day global thresholds; `test_spoofed_forwarded_for` asserts it does not change the limiter key for an untrusted peer.
- [ ] **Step 2: Run `pytest server/tests/test_ingest.py -q` red.**
- [ ] **Step 3: Implement the migration, repository, limiter, and route.** Check existing `run_id` before quota; make quota check and insert one transaction; use the proxy trust configuration rather than accepting arbitrary headers. Compare canonical JSON hashes, not timestamped request envelopes.
- [ ] **Step 4: Run the API tests green** with dependency-injected storage and inspect the SQL migration; Task 7 exercises the same route against PostgreSQL in CI, including uniqueness and concurrent insert behavior.
- [ ] **Step 5: Commit:** `feat: ingest anonymous lecture documents`.

### Task 3: Windows Bootstrap and Caption Fetch

**Files:** Create `plugins/lecture-notes/tools/bootstrap.ps1`, `plugins/lecture-notes/tools.lock.json`, `plugins/lecture-notes/scripts/url.ts`, `plugins/lecture-notes/scripts/captions.ts`, `plugins/lecture-notes/tests/url.test.ts`, `plugins/lecture-notes/tests/fetch.test.ts`, `plugins/lecture-notes/tests/bootstrap.test.ps1`.

**Interfaces:** `parseVideoId(url: string): string` accepts YouTube watch and short URLs only. `fetchCaption(videoId: string, workDir: string, toolPaths: {deno: string; ytdlp: string}): Promise<{captionPath: string; infoPath: string}>` writes Korean auto-caption JSON3 and metadata, skips video media, and throws `CaptionUnavailable` if that track cannot be obtained. `bootstrap.ps1` prints resolved absolute tool paths as JSON.

- [ ] **Step 1: Write failing URL and fetch tests.** `test_url_forms` asserts watch and short URLs yield the same 11-character ID; `test_lookalike_host` asserts rejection before invoking the stub; `test_fetch_text_only` asserts only caption/metadata files exist; `test_no_korean_auto_caption` asserts `CaptionUnavailable`.
- [ ] **Step 2: Run `deno test --allow-read --allow-write --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/url.test.ts plugins/lecture-notes/tests/fetch.test.ts` and `plugins/lecture-notes/tests/bootstrap.test.ps1` red.**
- [ ] **Step 3: Implement URL parsing, yt-dlp invocation, and PowerShell bootstrap.** The bootstrap checks existing tools first, downloads pinned official Windows releases into `workspace/.lecture-notes/tools` when absent, compares SHA-256 from `tools.lock.json`, and never modifies global PATH or requests administrator rights. Pass Deno to yt-dlp's JS runtime option.
- [ ] **Step 4: Run tests green** and execute a clean Windows bootstrap in a temporary workspace; confirm pinned versions, cache reuse, and checksum mismatch refusal.
- [ ] **Step 5: Commit:** `feat: fetch Korean captions with portable tools`.

### Task 4: Normalize and Chunk Three-Hour Captions

**Files:** Modify `plugins/lecture-notes/scripts/captions.ts`; create `plugins/lecture-notes/scripts/chunk.ts`, `plugins/lecture-notes/tests/captions.test.ts`, `plugins/lecture-notes/tests/chunk.test.ts`, `plugins/lecture-notes/tests/fixtures/captions.json3`.

**Interfaces:** `parseJson3(raw: unknown): Segment[]` from `captions.ts` returns 1-based ordered segments in seconds, preserving spoken meaning while removing empty caption events and exact overlap duplicates. `chunkSegments(segments: Segment[], maxChars: number, contextSegments: number): Chunk[]` returns disjoint editable ranges plus read-only neighbor context; default `maxChars=12000`, `contextSegments=3`.

- [ ] **Step 1: Write failing parser/chunk tests.** `test_empty_event` asserts it is skipped, `test_malformed_event` asserts a caption error, `test_overlap` asserts monotonic time and 1-based indices, and `test_three_hour_chunks` asserts every index appears in exactly one editable range and each chunk stays at or below 12,000 characters.
- [ ] **Step 2: Run `deno test --allow-read --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/captions.test.ts plugins/lecture-notes/tests/chunk.test.ts` red.**
- [ ] **Step 3: Implement `parseJson3` and `chunkSegments`** with time and coverage checks; Task 5's CLI writes their results to `segments.json` and per-chunk context files.
- [ ] **Step 4: Run tests green** and inspect one boundary file for the editable versus context range.
- [ ] **Step 5: Commit:** `feat: normalize and chunk lecture captions`.

### Task 5: Codex Judgment and Final Assembly

**Files:** Create `plugins/lecture-notes/skills/lecture-notes/SKILL.md`, `plugins/lecture-notes/scripts/assemble.ts`, `plugins/lecture-notes/scripts/cli.ts`, `plugins/lecture-notes/tests/assemble.test.ts`.

**Interfaces:** Before correction, the skill reads every prepared segment and writes `context/parts/<chunk>.json` plus `context/lecture.json`, summarizing the lecture flow, repeated terms with observed spellings and segment evidence, and possible misrecognitions. For a long lecture, it reads all chunks sequentially and merges their notes rather than truncating the transcript. The skill then writes `corrections/<chunk>.json` entries `{segment_idx, from, to, evidence_segment_idxs, reason}`, followed by `outline.json`, `summary_note.json`, and `glossary.json`. `assembleLecture(inputs: AssemblyInputs): LectureDocument` applies only exact correction matches, derives referenced times from segments, and calls `validateLecture`. CLI stages `doctor|fetch|prepare|assemble` are restartable from existing files; Task 7 adds `upload`.

- [ ] **Step 1: Write failing assembly tests.** `test_exact_correction` compares every untargeted segment byte for byte; `test_ambiguous_correction` asserts rejection; `test_correction_evidence_refs` rejects missing or out-of-range evidence segment references; `test_outline_coverage` asserts each segment index occurs in one leaf; `test_derived_times` asserts key point and glossary times equal their referenced segment starts.
- [ ] **Step 2: Run `deno test --allow-read --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/assemble.test.ts` red.**
- [ ] **Step 3: Implement assembly and skill instructions.** The skill first calls doctor/fetch/prepare and reads the complete transcript once through bounded chunks to build the whole-lecture context brief. It records recurring terms, their observed spellings and segment evidence, then corrects each chunk using that brief and neighboring source text. Corrections require a short reason and valid source segment references; uncertain candidates remain unchanged. The skill builds the 2-level outline and global overview/key points and glossary from corrected segments, writes JSON files, then assembles. It reports model uncertainty and never fabricates a transcript claim; failed jobs preserve intermediates for targeted retry.
- [ ] **Step 4: Run tests green** and perform a manual skill dry run on the fixture, verifying valid `lecture.json` and no video file.
- [ ] **Step 5: Commit:** `feat: assemble grounded lecture notes`.

### Task 6: Share Viewer and Expiration

**Files:** Create `server/app/views.py`, `server/app/templates/lecture.html`, `server/app/static/lecture.js`, `server/app/static/lecture.css`, `server/tests/test_viewer.py`, `server/tests/test_expiry.py`, `server/e2e/lecture.spec.ts`, `server/package.json`; modify `server/app/main.py`.

**Interfaces:** `GET /api/lectures/{share_token}` renders the page; `GET /api/lectures/{share_token}/data` returns the JSON until `expires_at`. A periodic process in the web service calls `Repository.delete_expired(now)`; reads also enforce expiration immediately. Viewer script maps clicked `start_sec` to YouTube IFrame seek and provides a timestamped YouTube fallback link when embedding fails.

- [ ] **Step 1: Write failing view/expiry tests.** `test_share_page` asserts status 200 and `noindex`; `test_unknown_or_expired` asserts 404; `test_escaped_segment` asserts `<script>` is absent from rendered HTML; `test_no_listing` asserts 404; browser `lecture.spec.ts` asserts chapter, key point, and glossary clicks seek to the expected seconds.
- [ ] **Step 2: Run `pytest server/tests/test_viewer.py server/tests/test_expiry.py -q` red** and `cd server; npm run test:e2e` red. The package script invokes Playwright against a fixture-backed local server.
- [ ] **Step 3: Implement the page, search, timestamp navigation, expiration job, and `noindex` response.** Use server-rendered escaped text; build embed URLs from validated video IDs only. Show the 90-day expiry date on the page.
- [ ] **Step 4: Run tests green** and inspect desktop/mobile screenshots and a real embedded video.
- [ ] **Step 5: Commit:** `feat: show unlisted lecture notes viewer`.

### Task 7: Upload, Marketplace, CI, and Release

**Files:** Create `plugins/lecture-notes/scripts/upload.ts`, `plugins/lecture-notes/tests/upload.test.ts`, `plugins/lecture-notes/plugin.json`, `.agents/plugins/marketplace.json`, `.github/workflows/ci.yml`, `Dockerfile`, `README.md`, `LICENSE`, `.gitignore`; modify `plugins/lecture-notes/scripts/cli.ts` and `plugins/lecture-notes/deno.json`.

**Interfaces:** `uploadLecture(path: string, baseUrl: string): Promise<{share_url: string; expires_at: string}>` sends the validated JSON and retries only transient transport/5xx failures with bounded backoff. `429` follows `Retry-After` or stops with a clear message; `409` reports a local run-ID conflict. The CLI prints the URL and expiry and keeps the JSON.

- [ ] **Step 1: Write failing upload tests.** `test_upload_once` asserts one POST with the fixture; `test_retry_same_document` asserts unchanged `run_id` and body; `test_rejected_upload` asserts distinct messages for 413/409/429; `test_transport_failure` asserts the input file still exists.
- [ ] **Step 2: Run `deno test --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/upload.test.ts` red.**
- [ ] **Step 3: Implement upload and package.** Add portable manifest and repo marketplace catalog named `lecture-notes-community` with `source.path: "./plugins/lecture-notes"`, installation `AVAILABLE`, authentication `ON_INSTALL`, category `Productivity`. README documents Windows install, first-run tool cache, public anonymous quotas, 90-day retention, and local retry. Add a Dockerfile that copies only server and shared schema, runs Uvicorn with proxy-header rewriting disabled, and sets the Railway trusted proxy CIDRs after observing the actual ingress peer. Add a CI workflow with Deno tests, pytest/PostgreSQL tests and manifest validation. Confirm the proposed MIT license with the user before publishing it.
- [ ] **Step 4: Run all local/CI checks and a clean Windows plugin install.** Process one public Korean lecture end to end, follow the share URL, exercise timestamp seeking, confirm the published ZIP/package contains the skill and scripts. Repair any failures and rerun only affected checks.
- [ ] **Step 5: Commit** the distribution changes. With the user's public-release authorization and verified GitHub/Railway access, create/connect the public GitHub repository, push the reviewed branch, connect Railway to it, configure PostgreSQL and server-only secrets, deploy after CI, and repeat the live upload/viewer smoke test. Record the repo, marketplace install instructions, and live URL.
