---
name: lecture-notes
description: Use when a Codex user supplies a Korean YouTube lecture URL and asks for a timestamped outline, overall notes, glossary, or a shareable lecture result.
---

# Lecture Notes

Turn one Korean YouTube lecture (up to 3 hours) into a grounded `lecture.json` and a public catalog entry. The scripts fetch, validate, and upload data; you do the contextual reading and writing. Tell the user before uploading that the new lecture's title and contents will be visible to every catalog visitor for 90 days.

## Prepare the run

1. Identify the installed plugin root as two directories above this `SKILL.md`. Use the user's current project as the workspace. Put a new run in `<workspace>/.lecture-notes/runs/<unique-id>`. Reuse that same directory when retrying a failed stage.
2. In PowerShell, run `<plugin-root>/tools/bootstrap.ps1 -WorkspacePath <workspace>` and parse its JSON output for `deno` and `ytdlp`. This downloads only pinned, checksum-verified portable tools into the workspace cache. Run the returned `deno.exe`; never use a different `yt-dlp` binary.
3. Run `deno run --allow-read --allow-write --allow-run --allow-net --config <plugin-root>/deno.json <plugin-root>/scripts/cli.ts doctor <workspace>`, then `fetch <youtube-url> <run-dir> <workspace>`, then `prepare <run-dir>` with the same Deno command prefix. Network permission is needed for the later HTTPS upload. A missing Korean auto-caption or invalid URL stops the job. Do not download video or audio.
4. Keep `source.json`, the original `*.ko.json3`, `*.info.json`, `segments.json`, and every `chunks/<number>.json`. They are the evidence for retries. Treat each chunk's `editable` array as the only text you may correct there; `context_before` and `context_after` are read-only context.

## First pass: understand the whole lecture

Read **every** prepared chunk in numeric order before making any correction. For long lectures, process chunks sequentially, write one concise `context/parts/<number>.json` immediately after reading each, and use those saved notes to merge the whole-lecture brief. Do not sample or truncate the remaining chunks because of context length. Each part has:

```json
{"chunk_idx":1,"start_idx":1,"end_idx":120,"flow":"What this portion teaches","terms":[{"term":"term as understood","spellings":["observed form"],"evidence_segment_idxs":[7,28]}],"possible_misrecognitions":[{"segment_idx":28,"observed":"source spelling","candidate":"possible intended spelling","reason":"contextual clue"}]}
```

Use the actual chunk bounds and actual segment references. The `flow` explains the argument or topic progression, not just keywords. Record recurring terms with observed spellings and evidence, including conflicting spellings. A suspected error is a hypothesis at this stage; leave `segments.json` unchanged.

After all parts exist, write `context/lecture.json` with `covered_chunk_idxs` listing **every** chunk number in order, `lecture_flow` summarizing the complete arc, `recurring_terms` merging observed spellings and evidence across chunks, and `possible_misrecognitions` containing candidates worth checking. The assembly command requires this complete context and all part files.

## Second pass: conservative correction

Revisit each chunk using the whole-lecture brief plus its read-only neighbors. Write `corrections/<number>.json` as an array. Each entry is `{"segment_idx":28,"from":"exact source phrase","to":"replacement phrase","evidence_segment_idxs":[7,28],"reason":"short contextual explanation"}`. Use only segment numbers in that chunk's `editable` range. The `from` phrase must appear exactly once in the original segment. Include attached particles in `from` and `to` when Korean grammar changes. Use valid source segment references; do not turn a contextual guess into a fact. If uncertain, omit the correction and note the uncertainty to the user. Write `[]` when a chunk needs no edits. Never edit `segments.json` directly.

## Build the outputs

Use the corrected reading to write these files in the run directory:

- `outline.json`: `{"chapters":[{"title":"...","summary":"...","start_idx":1,"end_idx":120,"children":[{"title":"...","summary":"...","start_idx":1,"end_idx":50}]}]}`. Main chapters and their children must cover every segment exactly once, in order. Omit time fields; the assembler derives them.
- `summary_note.json`: `{"overview":"...","key_points":[{"text":"...","segment_idxs":[12,13]}]}`. Give a lecture-wide overview and substantive key points with actual supporting segments. Avoid claims absent from the transcript.
- `glossary.json`: `[{"term":"...","explanation":"...","first_segment_idx":12}]`. Explain terms actually used or taught; anchor each at its first relevant explanation. An empty array is valid when no term qualifies.

Run `assemble <run-dir>` with the same Deno command prefix. It applies only exact, nonoverlapping corrections, derives all timestamps from segments, checks the shared JSON contract, and saves `lecture.json`. If validation fails, repair the named intermediate file and retry. Existing valid intermediates are reusable. If a different `lecture.json` already exists for that run ID, preserve it and start a new run rather than changing what an upload retry would send.

Run `upload <run-dir>` with the same Deno command prefix. The packaged `server.json` supplies the public server URL; no user account or API key is required. Upload only the validated `lecture.json`, never raw captions or video. On a transport or server error, keep every local file and retry `upload` with the same run directory. On HTTP 429, report the retry time; on 409, stop and report the run-ID conflict. Do not silently create a different JSON for the same run ID.

Report the local JSON path, share URL, 90-day expiration date, number of segments and chapters, meaningful uncertainties, and any failed stage. If the upload response contains `listing_url`, report it and confirm public catalog listing. If it does not, report only the share URL and do not claim catalog visibility; an older server may not support public listing. Do not invent missing transcript content or imply that an unverified semantic claim passed human review.
