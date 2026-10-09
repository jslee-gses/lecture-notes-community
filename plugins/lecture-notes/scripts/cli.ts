import {
  assembleEnglishLecture,
  assembleLecture,
  type AssemblyInputs,
  type Correction,
  type EnglishAssemblyInputs,
} from "./assemble.ts";
import { fetchCaption, parseJson3 } from "./captions.ts";
import { type Chunk, chunkSegments } from "./chunk.ts";
import type {
  EnglishLectureDocument,
  KoreanLectureDocument,
  LectureDocument,
  Segment,
} from "./types.ts";
import { parseVideoId } from "./url.ts";
import { uploadLecture, type UploadResult } from "./upload.ts";
import { parseVtt } from "./vtt.ts";

interface KoreanSource {
  schema_version: "1.0";
  run_id: string;
  lecture: KoreanLectureDocument["lecture"];
  caption_format?: "json3" | "vtt";
  caption_tag?: string;
  caption_file?: string;
}

interface EnglishSource {
  schema_version: "2.0";
  run_id: string;
  lecture: EnglishLectureDocument["lecture"];
  caption_format: "json3" | "vtt";
  caption_tag: string;
  caption_file: string;
}

type Source = KoreanSource | EnglishSource;

function path(base: string, relative: string): string {
  return `${base}/${relative}`;
}

async function readJson(file: string | URL): Promise<unknown> {
  try {
    return JSON.parse(await Deno.readTextFile(file));
  } catch (error) {
    throw new Error(`${file}: cannot read valid JSON (${String(error)})`);
  }
}

async function writeOnce(file: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  try {
    const existing = await Deno.readTextFile(file);
    if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(value)) {
      throw new Error(
        `${file}: existing content differs; preserve this run and use a new run directory`,
      );
    }
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const parent = file.slice(
    0,
    Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")),
  );
  await Deno.mkdir(parent, { recursive: true });
  await Deno.writeTextFile(file, serialized, { createNew: true });
}

function sourceFrom(value: unknown): Source {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("/source: expected an object");
  }
  const source = value as Source;
  if (source.schema_version !== "1.0" && source.schema_version !== "2.0") {
    throw new Error("/source/schema_version: unsupported version");
  }
  if (!source.lecture || typeof source.lecture.video_id !== "string") {
    throw new Error("/source/lecture/video_id: missing video ID");
  }
  if (source.schema_version === "2.0") {
    if (
      source.lecture.caption_language !== "en" ||
      !["manual", "auto"].includes(source.lecture.caption_source) ||
      source.lecture.translation_language !== "ko" ||
      !["json3", "vtt"].includes(source.caption_format) ||
      typeof source.caption_tag !== "string" ||
      !/^en(?:-[A-Za-z0-9_-]+)?$/u.test(source.caption_tag) ||
      source.caption_file !==
        `${source.lecture.video_id}.${source.caption_tag}.${source.caption_format}`
    ) throw new Error("/source: invalid English caption manifest");
  }
  return source;
}

export async function doctor(
  workspace: string,
): Promise<{ deno: string; ytdlp: string }> {
  const deno = path(workspace, ".lecture-notes/tools/deno.exe");
  const ytdlp = path(workspace, ".lecture-notes/tools/yt-dlp.exe");
  for (const file of [deno, ytdlp]) {
    const stat = await Deno.stat(file).catch(() => null);
    if (!stat?.isFile || stat.size === 0) {
      throw new Error(`${file}: missing tool; run tools/bootstrap.ps1 first`);
    }
  }
  return { deno, ytdlp };
}

export async function fetchRun(
  url: string,
  runDir: string,
  workspace: string,
  requestedLanguage: "ko" | "en" | "auto" = "auto",
): Promise<Source> {
  const videoId = parseVideoId(url);
  const infoPath = path(runDir, `${videoId}.info.json`);
  const sourcePath = path(runDir, "source.json");
  const sourceStat = await Deno.stat(sourcePath).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  });
  const existing = sourceStat
    ? sourceFrom(await readJson(sourcePath))
    : undefined;
  if (existing && existing.lecture.video_id !== videoId) {
    throw new Error(
      "/source/lecture/video_id: run directory belongs to another video",
    );
  }
  if (
    existing && requestedLanguage !== "auto" &&
    existing.lecture.caption_language !== requestedLanguage
  ) {
    throw new Error(
      "/source/lecture/caption_language: run directory belongs to another language",
    );
  }
  const captionName = existing?.caption_file ?? `${videoId}.ko.json3`;
  const captionPath = path(runDir, captionName);
  const caption = await Deno.stat(captionPath).catch(() => null);
  const info = await Deno.stat(infoPath).catch(() => null);
  let fetched: Awaited<ReturnType<typeof fetchCaption>> | undefined;
  if (!caption && !info) {
    if (existing) {
      throw new Error("/source: manifest exists but caption files are missing");
    }
    const tools = await doctor(workspace);
    fetched = await fetchCaption(
      videoId,
      runDir,
      {
        deno: tools.deno,
        ytdlp: tools.ytdlp,
      },
      undefined,
      requestedLanguage,
    );
  } else if (!caption?.isFile || !info?.isFile || !caption.size || !info.size) {
    throw new Error(
      "/source: partial caption fetch; keep files for inspection and retry in a new run directory",
    );
  }
  const metadata = await readJson(infoPath) as Record<string, unknown>;
  if (
    !metadata || metadata.id !== videoId ||
    typeof metadata.title !== "string" ||
    !metadata.title.trim() || typeof metadata.duration !== "number" ||
    !Number.isFinite(metadata.duration) || metadata.duration <= 0 ||
    metadata.duration > 10800
  ) {
    throw new Error(
      `${infoPath}: invalid title, ID, or duration (maximum 3 hours)`,
    );
  }
  if (
    existing &&
    (existing.lecture.title !== metadata.title ||
      existing.lecture.duration_sec !== metadata.duration)
  ) throw new Error(`${infoPath}: metadata differs from the saved run`);
  const shared = {
    video_id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: metadata.title as string,
    duration_sec: metadata.duration as number,
    created_at: new Date().toISOString(),
  };
  const source: Source = existing ?? (fetched?.track.language === "en"
    ? {
      schema_version: "2.0",
      run_id: crypto.randomUUID(),
      lecture: {
        ...shared,
        caption_language: "en",
        caption_source: fetched.track.source,
        translation_language: "ko",
      },
      caption_format: fetched.track.format,
      caption_tag: fetched.track.tag,
      caption_file: `${videoId}.${fetched.track.tag}.${fetched.track.format}`,
    }
    : {
      schema_version: "1.0",
      run_id: crypto.randomUUID(),
      lecture: { ...shared, caption_language: "ko", caption_source: "auto" },
      caption_format: fetched?.track.format,
      caption_tag: fetched?.track.tag,
      caption_file: fetched
        ? `${videoId}.${fetched.track.tag}.${fetched.track.format}`
        : undefined,
    });
  await writeOnce(path(runDir, "source.json"), source);
  return source;
}

export async function prepareRun(runDir: string): Promise<Chunk[]> {
  const source = sourceFrom(await readJson(path(runDir, "source.json")));
  const captionPath = path(
    runDir,
    source.caption_file ?? `${source.lecture.video_id}.ko.json3`,
  );
  const segments = source.caption_format === "vtt"
    ? parseVtt(await Deno.readTextFile(captionPath))
    : parseJson3(await readJson(captionPath));
  const duration = source.lecture.duration_sec;
  if (segments.at(-1)!.end_sec > duration) {
    const tail = segments.at(-1)!;
    if (
      tail.end_sec - duration > 5 ||
      segments.some((segment) => segment.start_sec >= duration)
    ) {
      throw new Error("/segments: caption extends past video duration");
    }
    tail.end_sec = duration;
  }
  const chunks = chunkSegments(segments);
  await writeOnce(path(runDir, "segments.json"), segments);
  for (const chunk of chunks) {
    await writeOnce(path(runDir, `chunks/${chunk.chunk_idx}.json`), chunk);
  }
  return chunks;
}

async function preparedChunks(
  runDir: string,
  segments: Segment[],
): Promise<Chunk[]> {
  const expected = chunkSegments(segments);
  const found = [...Deno.readDirSync(path(runDir, "chunks"))]
    .filter((entry) => entry.isFile && /^\d+\.json$/.test(entry.name)).length;
  if (found !== expected.length) {
    throw new Error("/chunks: missing or extra chunk files");
  }
  for (const chunk of expected) {
    const file = path(runDir, `chunks/${chunk.chunk_idx}.json`);
    if (JSON.stringify(await readJson(file)) !== JSON.stringify(chunk)) {
      throw new Error(`${file}: chunk differs from prepared segments`);
    }
  }
  return expected;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function assembleRun(runDir: string): Promise<LectureDocument> {
  const source = sourceFrom(await readJson(path(runDir, "source.json")));
  const segments = await readJson(path(runDir, "segments.json")) as Segment[];
  const chunks = await preparedChunks(runDir, segments);

  for (const chunk of chunks) {
    const file = path(runDir, `context/parts/${chunk.chunk_idx}.json`);
    const part = await readJson(file);
    if (
      !isObject(part) || part.chunk_idx !== chunk.chunk_idx ||
      part.start_idx !== chunk.start_idx || part.end_idx !== chunk.end_idx ||
      typeof part.flow !== "string" || !part.flow.trim() ||
      !Array.isArray(part.terms) ||
      !Array.isArray(part.possible_misrecognitions)
    ) throw new Error(`${file}: incomplete chunk context`);
  }
  const contextPath = path(runDir, "context/lecture.json");
  const context = await readJson(contextPath);
  if (
    !isObject(context) ||
    JSON.stringify(context.covered_chunk_idxs) !==
      JSON.stringify(chunks.map((chunk) => chunk.chunk_idx)) ||
    typeof context.lecture_flow !== "string" || !context.lecture_flow.trim() ||
    !Array.isArray(context.recurring_terms) ||
    !Array.isArray(context.possible_misrecognitions)
  ) throw new Error(`${contextPath}: incomplete whole-lecture context`);

  const corrections: Correction[] = [];
  for (const chunk of chunks) {
    const file = path(runDir, `corrections/${chunk.chunk_idx}.json`);
    const part = await readJson(file);
    if (!Array.isArray(part)) {
      throw new Error(`${file}: expected a correction array`);
    }
    for (const [i, edit] of part.entries()) {
      if (
        !isObject(edit) || !Number.isInteger(edit.segment_idx) ||
        (edit.segment_idx as number) < chunk.start_idx ||
        (edit.segment_idx as number) > chunk.end_idx
      ) {
        throw new Error(
          `${file}/${i}/segment_idx: correction outside editable range`,
        );
      }
      corrections.push(edit as unknown as Correction);
    }
  }
  const inputs = {
    ...source,
    segments,
    corrections,
    outline: await readJson(
      path(runDir, "outline.json"),
    ) as AssemblyInputs["outline"],
    summary_note: await readJson(
      path(runDir, "summary_note.json"),
    ) as AssemblyInputs["summary_note"],
    glossary: await readJson(
      path(runDir, "glossary.json"),
    ) as AssemblyInputs["glossary"],
  };
  let lecture: LectureDocument;
  if (source.schema_version === "2.0") {
    const translations: EnglishAssemblyInputs["translations"] = [];
    for (const chunk of chunks) {
      const file = path(runDir, `translations/${chunk.chunk_idx}.json`);
      const part = await readJson(file);
      if (!Array.isArray(part)) {
        throw new Error(`${file}: expected a translation array`);
      }
      const expected = new Set(chunk.editable.map((segment) => segment.idx));
      const found = new Set<number>();
      for (const [i, entry] of part.entries()) {
        if (
          !isObject(entry) || !Number.isInteger(entry.segment_idx) ||
          !expected.has(entry.segment_idx as number) ||
          found.has(entry.segment_idx as number)
        ) {
          throw new Error(
            `${file}/${i}/segment_idx: translation outside editable range or duplicate`,
          );
        }
        found.add(entry.segment_idx as number);
        translations.push(
          entry as unknown as EnglishAssemblyInputs["translations"][number],
        );
      }
      if (found.size !== expected.size) {
        throw new Error(`${file}: missing translations for editable segments`);
      }
    }
    lecture = assembleEnglishLecture({
      ...inputs,
      schema_version: "2.0",
      lecture: source.lecture,
      translations,
    });
  } else {
    lecture = assembleLecture({
      ...inputs,
      schema_version: "1.0",
      lecture: source.lecture,
    });
  }
  await writeOnce(path(runDir, "lecture.json"), lecture);
  return lecture;
}

export async function uploadRun(
  runDir: string,
  serverUrl?: string,
): Promise<UploadResult> {
  let baseUrl = serverUrl;
  if (!baseUrl) {
    const config = await readJson(new URL("../server.json", import.meta.url));
    if (
      !isObject(config) || typeof config.base_url !== "string" ||
      !config.base_url
    ) {
      throw new Error(
        "public upload server is not configured in the plugin package",
      );
    }
    baseUrl = config.base_url;
  }
  return await uploadLecture(path(runDir, "lecture.json"), baseUrl);
}

if (import.meta.main) {
  try {
    const [command, ...args] = Deno.args;
    let result: unknown;
    if (command === "doctor" && args.length === 1) {
      result = await doctor(args[0]);
    } else if (
      command === "fetch" && (args.length === 3 || args.length === 4)
    ) {
      if (args[3] && !["ko", "en", "auto"].includes(args[3])) {
        throw new Error("fetch language must be ko, en or auto");
      }
      result = await fetchRun(
        args[0],
        args[1],
        args[2],
        args[3] as "ko" | "en" | "auto" | undefined,
      );
    } else if (command === "prepare" && args.length === 1) {
      result = { chunks: (await prepareRun(args[0])).length };
    } else if (command === "assemble" && args.length === 1) {
      const doc = await assembleRun(args[0]);
      result = { path: path(args[0], "lecture.json"), run_id: doc.run_id };
    } else if (
      command === "upload" && (args.length === 1 || args.length === 2)
    ) {
      result = await uploadRun(args[0], args[1]);
    } else {
      throw new Error(
        "Usage: cli.ts doctor <workspace> | fetch <url> <run-dir> <workspace> [ko|en|auto] | prepare <run-dir> | assemble <run-dir> | upload <run-dir> [server-url]",
      );
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(String(error));
    Deno.exitCode = 1;
  }
}
