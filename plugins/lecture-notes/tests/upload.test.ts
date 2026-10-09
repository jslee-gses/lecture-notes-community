import { uploadLecture } from "../scripts/upload.ts";

const fixtureText = await Deno.readTextFile(
  new URL("./fixtures/valid-lecture.json", import.meta.url),
);

async function withFixture(run: (file: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const file = `${dir}/lecture.json`;
  try {
    await Deno.writeTextFile(file, fixtureText);
    await run(file);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const success = () =>
  new Response(
    JSON.stringify({
      share_url: "https://notes.example/api/lectures/share-token",
      expires_at: "2027-01-07T12:00:00Z",
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );

Deno.test("test_upload_once", async () => {
  await withFixture(async (file) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return success();
    };
    const result = await uploadLecture(file, "https://notes.example/", {
      fetcher,
    });
    if (
      calls.length !== 1 ||
      calls[0].url !== "https://notes.example/api/lectures"
    ) {
      throw new Error("Expected one POST to the lecture endpoint");
    }
    if (calls[0].init.method !== "POST" || calls[0].init.body !== fixtureText) {
      throw new Error("Upload changed the document body");
    }
    if (
      (calls[0].init.headers as Record<string, string>)["X-Lecture-Listing"] !==
        "public"
    ) {
      throw new Error("Upload did not opt in to the public catalog");
    }
    if (result.share_url !== "https://notes.example/api/lectures/share-token") {
      throw new Error("Share URL was not returned");
    }
  });
});

Deno.test("test_retry_same_document", async () => {
  await withFixture(async (file) => {
    const bodies: string[] = [];
    const listingHeaders: string[] = [];
    let attempts = 0;
    const result = await uploadLecture(file, "https://notes.example", {
      fetcher: async (_url, init) => {
        bodies.push(String(init?.body));
        listingHeaders.push(
          (init?.headers as Record<string, string>)["X-Lecture-Listing"],
        );
        attempts++;
        return attempts === 1
          ? new Response("unavailable", { status: 503 })
          : success();
      },
      sleep: async () => {},
    });
    if (attempts !== 2 || bodies[0] !== bodies[1]) {
      throw new Error("Retry changed the request body");
    }
    if (listingHeaders.some((value) => value !== "public")) {
      throw new Error("Retry lost the public listing signal");
    }
    const original = JSON.parse(fixtureText);
    if (JSON.parse(bodies[1]).run_id !== original.run_id || !result.share_url) {
      throw new Error("Retry changed the run ID");
    }
  });
});

Deno.test("test_missing_listing_confirmation", async () => {
  await withFixture(async (file) => {
    const oldResult = await uploadLecture(file, "https://notes.example", {
      fetcher: async () => success(),
    });
    if ("listing_url" in oldResult) {
      throw new Error("Old server response claimed public listing");
    }
    const confirmed = await uploadLecture(file, "https://notes.example", {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            share_url: "https://notes.example/api/lectures/share-token",
            expires_at: "2027-01-07T12:00:00Z",
            listing_url: "https://notes.example/",
          }),
          { status: 201 },
        ),
    });
    if (confirmed.listing_url !== "https://notes.example/") {
      throw new Error("Listing URL was lost");
    }
    try {
      await uploadLecture(file, "https://notes.example", {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              share_url: "https://notes.example/api/lectures/share-token",
              expires_at: "2027-01-07T12:00:00Z",
              listing_url: "https://attacker.example/",
            }),
            { status: 201 },
          ),
      });
      throw new Error("Cross-origin listing URL was accepted");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("listing URL")) {
        throw error;
      }
    }
  });
});

Deno.test("test_rejected_upload", async () => {
  await withFixture(async (file) => {
    const cases = [
      { status: 413, marker: "413" },
      { status: 409, marker: "409" },
      { status: 429, marker: "Retry-After: 3600" },
    ];
    for (const item of cases) {
      let attempts = 0;
      try {
        await uploadLecture(file, "https://notes.example", {
          fetcher: async () => {
            attempts++;
            return new Response(JSON.stringify({ detail: "rejected" }), {
              status: item.status,
              headers: item.status === 429 ? { "Retry-After": "3600" } : {},
            });
          },
          sleep: async () => {},
        });
        throw new Error(`HTTP ${item.status} was accepted`);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes(item.marker)) {
          throw error;
        }
      }
      if (attempts !== 1) throw new Error(`HTTP ${item.status} was retried`);
    }
  });
});

Deno.test("test_transport_failure", async () => {
  await withFixture(async (file) => {
    let attempts = 0;
    try {
      await uploadLecture(file, "https://notes.example", {
        fetcher: async () => {
          attempts++;
          throw new TypeError("offline");
        },
        sleep: async () => {},
      });
      throw new Error("Transport failure was accepted");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("network")) {
        throw error;
      }
    }
    if (attempts !== 3 || await Deno.readTextFile(file) !== fixtureText) {
      throw new Error("Input file was lost or retry count was unbounded");
    }
  });
});
