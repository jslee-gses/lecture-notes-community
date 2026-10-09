# Lecture Viewer and Public Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give lecture pages a white, video-first workspace and show newly opted-in uploads on a public home page.

**Architecture:** Keep FastAPI/Jinja, PostgreSQL and the existing share URLs. A database visibility flag defaults to private; only the updated plugin sends an explicit public upload header. The detail page uses semantic tabs and an internally scrolling transcript with safe text highlighting.

**Tech Stack:** Python 3.12, FastAPI, Jinja2, PostgreSQL 17, Deno 2.5.6, TypeScript, Playwright 1.64.0, Railway.

**Spec:** `docs/superpowers/specs/2026-10-09-lecture-viewer-catalog-english-design.md` (approved 2026-10-09), especially “상세 화면” and “공개 목록과 업로드 호환성”.

## Global Constraints

- This plan is release stage 1. Do not change Korean JSON `schema_version: "1.0"`, existing share URLs, the 90-day retention rule, or the 10 MiB upload limit.
- Existing rows and uploads from plugin 0.1.1 or earlier stay unlisted; the updated plugin sends `X-Lecture-Listing: public` for new uploads.
- `GET /` shows only active listed results, 20 per page, newest first. `GET /api/lectures` remains 404.
- The detail page removes the three exact phrases and every `LECTURE / NOTES` label named in the spec; background is white.
- Desktop order: video and transcript left, outline/summary/glossary tabs right. Mobile order: video, transcript, tabs. Transcript scrolling keeps the video visible.
- HTML from uploaded titles or transcript stays escaped. Search highlighting must create text nodes and `<mark>` elements, never assign untrusted text to `innerHTML`.
- At the release gate, present local and CI evidence for user approval before pushing a public plugin release or deploying to Railway.
- Implement on a feature branch and run GitHub CI through a pull request; merging to `main` triggers Railway, so merge only after deployment approval.

## Review Focus

- An old database row must remain unlisted after migration; `test_public_listing_migration_preserves_old_rows` in Task 1.
- A retry with a changed listing header must preserve the original URL, visibility and quota count; `test_retry_cannot_change_listing` in Task 2.
- A blank or unexpected listing header must return 422, rather than silently changing visibility; `test_bad_listing_header` in Task 2.
- An expired listed lecture must disappear even before cleanup, while a title containing HTML renders as text; `test_catalog_expiry_and_escaping` in Task 4.
- Regex punctuation or HTML-like search terms must not break highlighting or script safety, and a long transcript must leave the player in place; `search_highlight_is_safe_and_player_stays_visible` in Task 5.

## File Map

- `server/migrations/002_public_listing.sql`: visibility column and partial public-list index.
- `server/app/migrate.py`: apply all numbered, idempotent SQL migrations under the existing advisory lock.
- `server/app/models.py`, `repository.py`: persisted visibility and a lightweight `PublicLecture` result for page queries; memory repository mirrors PostgreSQL.
- `server/app/main.py`: parse the public listing header and return a listing URL for newly public uploads.
- `plugins/lecture-notes/scripts/upload.ts`, `tests/upload.test.ts`, `skills/lecture-notes/SKILL.md`, `README.md`: explicit public upload signal and user-facing visibility notice.
- `server/app/views.py`, new `server/app/templates/catalog.html`, new `server/app/static/catalog.css`: public home page.
- `server/app/templates/lecture.html`, `server/app/static/lecture.css`, `lecture.js`, `server/e2e/lecture.spec.ts`: video-first responsive viewer, accessible tabs and highlighted search.
- `server/tests/test_postgres.py`, `test_ingest.py`, `test_viewer.py`, `.github/workflows/ci.yml`: persistence, API, rendering and browser CI verification.

---

### Task 1: Visibility Storage and Public Query

**Files:** Create `server/migrations/002_public_listing.sql`; modify `server/app/migrate.py`, `models.py`, `repository.py`; test `server/tests/test_postgres.py`, `test_ingest.py`.

**Interfaces:** `Repository.insert_or_get(doc: dict, client_key: str, previous_client_key: str | None = None, *, is_listed: bool = False) -> SavedLecture` and the matching memory method. Add `SavedLecture.is_listed: bool = False` and `PublicLecture(share_token, title, duration_sec, created_at)`. Both repositories provide `list_public(page: int, page_size: int = 20) -> tuple[list[PublicLecture], bool]`, where the boolean indicates a next page.

- [ ] **Step 1: Write failing storage tests.** `test_public_listing_migration_preserves_old_rows` creates a pre-migration row, applies all migrations twice and asserts `is_listed=False`. `test_public_query_order_and_page_size` inserts 21 listed rows plus one unlisted row, asserts page 1 has 20 newest rows, `has_next=True`, and page 2 has one row. Assert no expired row appears even before deletion.
- [ ] **Step 2: Run tests red.** `python -m pytest -q server/tests/test_postgres.py server/tests/test_ingest.py -k 'public_listing_migration or public_query'`; expect missing column or method failure. PostgreSQL tests run in CI with `TEST_DATABASE_URL` if no local database is available.
- [ ] **Step 3: Implement storage.** Add `is_listed BOOLEAN NOT NULL DEFAULT FALSE`, a partial index on `(created_at DESC, run_id DESC) WHERE is_listed`, and numbered migration iteration in `apply_migrations(database_url: str)`. Insert visibility only on a new row; leave it immutable on a retry. Query only title, duration and creation time from listed, unexpired rows, ordering by `created_at DESC, run_id DESC` and fetching `page_size + 1` rows. Mirror semantics in `MemoryRepository`.
- [ ] **Step 4: Run tests green.** Run the command from Step 2 and `python -m pytest -q server/tests`; expect all non-DB tests green and PostgreSQL tests green in CI.
- [ ] **Step 5: Commit.** `git add server/migrations server/app/migrate.py server/app/models.py server/app/repository.py server/tests && git commit -m "feat: store opt-in public lecture visibility"`.

### Task 2: Upload Visibility Contract

**Files:** Modify `server/app/main.py`, `server/tests/test_ingest.py`, `server/tests/test_postgres.py`.

**Interfaces:** `POST /api/lectures` accepts no `X-Lecture-Listing` header for unlisted uploads or the exact value `public` for listed uploads. Any other present value returns 422. A newly listed result adds `listing_url: <PUBLIC_BASE_URL>/` to the existing response; unlisted responses retain `share_url` and `expires_at` only.

- [ ] **Step 1: Write failing API tests.** `test_public_upload_returns_listing_url` asserts 201, listed storage and the root URL. `test_old_client_upload_stays_unlisted` asserts no header means no catalog entry. `test_retry_cannot_change_listing` checks both private→public and public→private retries preserve original visibility, share URL and quota count. `test_bad_listing_header` checks `""`, `"private"` and `"PUBLIC"` return 422 without insertion.
- [ ] **Step 2: Run tests red.** `python -m pytest -q server/tests/test_ingest.py -k 'listing or public_upload or old_client'`; expect failures in new assertions.
- [ ] **Step 3: Implement header handling in `create_app`.** Parse the header before repository insertion; pass `is_listed` to `insert_or_get`. Build the response from `saved.is_listed`, so a retry never reports an unlisted legacy row as public. Preserve 409, 413, 422, 429 and 503 behavior.
- [ ] **Step 4: Run tests green.** Run Step 2 and `python -m pytest -q server/tests`; expect all available tests green.
- [ ] **Step 5: Commit.** `git add server/app/main.py server/tests && git commit -m "feat: accept explicit public lecture uploads"`.

### Task 3: Plugin Public Upload Notice

**Files:** Modify `plugins/lecture-notes/scripts/upload.ts`, `plugins/lecture-notes/tests/upload.test.ts`, `plugins/lecture-notes/skills/lecture-notes/SKILL.md`, `README.md`, `plugins/lecture-notes/plugin.json`.

**Interfaces:** `uploadLecture(file: string, baseUrl: string, options?: UploadOptions) -> Promise<UploadResult>` sends `X-Lecture-Listing: public` with each attempt. `UploadResult` has optional `listing_url`; validate its HTTPS origin if present. The skill tells the user that new results are visible from the public catalog and reports whether the server confirmed a `listing_url`.

- [ ] **Step 1: Write failing Deno tests.** `test_upload_once` asserts the public header and unchanged JSON body. `test_retry_same_document` asserts all attempts carry the same header and run ID. `test_missing_listing_confirmation` asserts an older server response yields the share URL but no claim of catalog listing; a listing URL on a different origin is rejected.
- [ ] **Step 2: Run tests red.** `deno test --allow-read --allow-write --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/upload.test.ts`; expect new header/response assertions to fail.
- [ ] **Step 3: Implement the signal and wording.** Extend `UploadResult`, validate optional `listing_url`, send the header in `uploadLecture`, and update the skill and README to state that the title and contents of new updated-plugin uploads appear in the public catalog. Bump the plugin manifest from 0.1.1 to 0.2.0; keep the old server response truthful.
- [ ] **Step 4: Run tests green.** Run Step 2 plus `deno check --config plugins/lecture-notes/deno.json plugins/lecture-notes/scripts/cli.ts`; expect success.
- [ ] **Step 5: Commit.** `git add plugins/lecture-notes README.md && git commit -m "feat: opt in updated plugin uploads to catalog"`.

### Task 4: Public Home Page

**Files:** Create `server/app/templates/catalog.html`, `server/app/static/catalog.css`; modify `server/app/views.py`, `server/tests/test_viewer.py`, `server/e2e/fixture_server.py`.

**Interfaces:** `GET /?page=<positive integer>` returns a Jinja-rendered list of `Repository.list_public(page, 20)` entries and next/previous links. Missing page means page 1; page `<1` or `>1000` returns 422. `GET /api/lectures` remains 404.

- [ ] **Step 1: Write failing page tests.** `test_catalog_empty_and_new_public_entry` asserts a useful empty state then a detail link after public upload. `test_catalog_pagination` checks 21 entries and navigation. `test_catalog_expiry_and_escaping` asserts expired rows are absent, unlisted rows are absent, and `<script>` in a title is escaped. Existing share URLs still render.
- [ ] **Step 2: Run tests red.** `python -m pytest -q server/tests/test_viewer.py -k 'catalog'`; expect root 404 or missing content.
- [ ] **Step 3: Implement catalog route and template.** Render only the lightweight public items; show title, duration and upload date in white-background cards. Encode share URLs using stored random tokens, not video IDs or sequential row numbers. Add a link back to `/` on the detail page in Task 5.
- [ ] **Step 4: Run tests green.** Run Step 2 and `python -m pytest -q server/tests`; expect all available tests green.
- [ ] **Step 5: Commit.** `git add server/app/views.py server/app/templates/catalog.html server/app/static/catalog.css server/tests/test_viewer.py server/e2e/fixture_server.py && git commit -m "feat: show new public lectures on home page"`.

### Task 5: Video-First Detail Viewer

**Files:** Modify `server/app/templates/lecture.html`, `server/app/static/lecture.css`, `lecture.js`, `server/e2e/lecture.spec.ts`, `server/e2e/fixture_server.py`, `server/tests/test_viewer.py`, `.github/workflows/ci.yml`.

**Interfaces:** Detail HTML exposes `tablist` with tabs and panels for `목차`, `강의 요약`, `용어집`; transcript rows keep `data-transcript-row` and time buttons keep `data-seek`. `#transcript-search`, `#search-count`, `#search-empty` remain stable for browser tests.

- [ ] **Step 1: Write failing browser and HTML tests.** `tabs_switch_without_resetting_player` checks click, arrows, Home/End and player identity. `search_highlight_is_safe_and_player_stays_visible` uses a long fixture plus regex punctuation and `<script>`-like text, asserts `<mark>` matches, count, empty/reset behavior, unchanged player bounding box while `transcript-list.scrollTop` changes, and no executed script. `mobile_order_and_white_background` checks computed background, video→transcript→tabs order and no clipped controls. Update the seek test to switch tabs before clicking note/glossary; assert the three exact phrases and `LECTURE / NOTES` are absent.
- [ ] **Step 2: Run tests red.** From `server/`, run `npm run test:e2e` and from repo root `python -m pytest -q server/tests/test_viewer.py`; expect the new layout and tab assertions to fail.
- [ ] **Step 3: Implement HTML, CSS and JavaScript.** Use a wider left grid column, fixed-height internal transcript scroller, white canvas, accessible tab state and keyboard handling. Highlight by splitting text nodes and creating `<mark>`, never setting uploaded text as HTML. Remove the current `scrollIntoView` on seek. Preserve YouTube fallback and mobile sequence. Add a long fixture route in `fixture_server.py` and a Chromium browser job to CI so these tests run on pull requests and pushes.
- [ ] **Step 4: Run tests green.** Run Step 2, `python -m pytest -q server/tests`, `deno test --allow-read --allow-write --allow-run --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/*.test.ts`, and `git diff --check`; inspect desktop and mobile screenshots. Expect all green and the video to stay visible during transcript scrolling.
- [ ] **Step 5: Commit.** `git add server/app/templates/lecture.html server/app/static/lecture.css server/app/static/lecture.js server/e2e/lecture.spec.ts server/e2e/fixture_server.py server/tests/test_viewer.py .github/workflows/ci.yml && git commit -m "feat: add video-first lecture workspace"`.

## Stage 1 Release Gate

- [ ] Run `python -m pytest -q server/tests`, `deno test --allow-read --allow-write --allow-run --config plugins/lecture-notes/deno.json plugins/lecture-notes/tests/*.test.ts`, `npm --prefix server run test:e2e`, and `git diff --check`. Push the feature branch as a pull request and require its Windows bootstrap, PostgreSQL, Docker and browser jobs to pass; record exact results and review the diff against the approved spec.
- [ ] Present the working local page, public catalog behavior, privacy compatibility and CI evidence to the user for **deployment approval**. Do not deploy or publish the new plugin version before that approval.
- [ ] After approval, merge the tested revision to `main`, wait for CI and Railway success, verify `/` and the existing Korean share URL, publish the 0.2.0 GitHub ZIP, then install the updated marketplace plugin for an end-to-end public upload smoke test.
