import { CaptionDataError } from "../scripts/captions.ts";

async function parse(text: string) {
  const modulePath = "../scripts/" + "vtt.ts";
  let module: Record<string, unknown>;
  try {
    module = await import(modulePath);
  } catch {
    throw new Error("VTT parser is missing");
  }
  if (typeof module.parseVtt !== "function") {
    throw new Error("VTT parser is missing");
  }
  return module.parseVtt(text) as {
    idx: number;
    start_sec: number;
    end_sec: number;
    text: string;
  }[];
}

Deno.test("vtt_multiline_entities_html_and_overlap", async () => {
  const segments = await parse(`WEBVTT

cue-1
00:00:00.500 --> 00:00:02.500
Hello &amp; <script>window.__injected=true</script>
world

00:00:02.400 --> 00:00:03.000 align:start
C++ [array]
`);
  if (segments.length !== 2 || segments[0].idx !== 1 || segments[1].idx !== 2) {
    throw new Error("Cue count or indices changed");
  }
  if (
    segments[0].start_sec !== 0.5 || segments[0].end_sec !== 2.4 ||
    segments[1].start_sec !== 2.4
  ) throw new Error("VTT timing was not preserved and normalized");
  if (
    segments[0].text !==
      "Hello & <script>window.__injected=true</script> world" ||
    segments[1].text !== "C++ [array]"
  ) throw new Error("VTT cue text changed");
});

Deno.test("vtt_rejects_empty_or_malformed_cues", async () => {
  for (
    const input of [
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n\n",
      "WEBVTT\n\nnot a cue\nhello\n",
    ]
  ) {
    try {
      await parse(input);
      throw new Error("Bad VTT was accepted");
    } catch (error) {
      if (!(error instanceof CaptionDataError)) throw error;
    }
  }
});
