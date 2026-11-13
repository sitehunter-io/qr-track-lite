/** KV/Durable Object consistency, abuse limits and the other pre-release hardening. */
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALERT_MAX, NETWORK_MAX_SCANS, type ScanCounter } from "../src/counter";
import { kvKey } from "../src/links";
import { ANDROID_CHROME, AUSTIN, call, createLink, IPHONE_SAFARI, nextIp, ORIGIN, scan, testEnv, uniqueSlug } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const stub = (slug: string) => testEnv.SCANS.get(testEnv.SCANS.idFromName(slug));

/** Makes the link's Durable Object see a KV namespace whose writes (or reads) fail, like a KV 429. */
async function breakKv(slug: string, { failWrites = true } = {}) {
  await runInDurableObject(stub(slug), (instance: ScanCounter) => {
    const real = testEnv.LINKS;
    const failing = {
      get: real.get.bind(real),
      list: real.list.bind(real),
      getWithMetadata: real.getWithMetadata.bind(real),
      put: failWrites ? () => Promise.reject(new Error("KV PUT failed: 429 Too Many Requests")) : real.put.bind(real),
      delete: failWrites ? () => Promise.reject(new Error("KV DELETE failed: 429 Too Many Requests")) : real.delete.bind(real),
    } as unknown as KVNamespace;
    (instance as unknown as { env: object }).env = { ...testEnv, LINKS: failing };
  });
}

/** KV whose first write or delete is slow, so an unordered writer would land them out of order. */
async function slowFirstKvWrite(slug: string) {
  await runInDurableObject(stub(slug), (instance: ScanCounter) => {
    const real = testEnv.LINKS;
    let calls = 0;
    const delayed =
      <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      async (...args: A) => {
        const delay = calls++ === 0 ? 80 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return fn(...args);
      };
    const slow = {
      get: real.get.bind(real),
      list: real.list.bind(real),
      getWithMetadata: real.getWithMetadata.bind(real),
      put: delayed(real.put.bind(real)),
      delete: delayed(real.delete.bind(real)),
    } as unknown as KVNamespace;
    (instance as unknown as { env: object }).env = { ...testEnv, LINKS: slow };
  });
}

async function restoreKv(slug: string) {
  await runInDurableObject(stub(slug), (instance: ScanCounter) => {
    (instance as unknown as { env: object }).env = testEnv;
  });
}

const kvRecord = async (slug: string) => testEnv.LINKS.get<{ destination: string }>(kvKey(slug), "json");
const apiRecord = async (slug: string) => {
  const response = await call(`/api/links/${slug}`);
  return response.status === 200 ? ((await response.json()) as { destination: string }) : null;
};

function quiet() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("KV and the Durable Object never disagree", () => {
  it("rolls back a create when KV refuses the write", async () => {
    quiet();
    const slug = uniqueSlug("kvc");
    await breakKv(slug);
    const response = await call("/api/links", { method: "POST", body: { slug, destination: "https://example.com" } });
    expect(response.status).toBe(503);
    expect(await kvRecord(slug)).toBeNull();
    expect(await apiRecord(slug)).toBeNull();

    await restoreKv(slug);
    const retry = await call("/api/links", { method: "POST", body: { slug, destination: "https://example.com" } });
    expect(retry.status).toBe(201);
  });

  it("rolls back a destination change when KV refuses the write", async () => {
    quiet();
    const link = await createLink({ destination: "https://old.example/" });
    await breakKv(link.slug);
    const response = await call(`/api/links/${link.slug}`, { method: "PATCH", body: { destination: "https://new.example/" } });
    expect(response.status).toBe(503);
    expect((await apiRecord(link.slug))?.destination).toBe("https://old.example/");
    expect((await kvRecord(link.slug))?.destination).toBe("https://old.example/");
    expect((await scan(link.slug)).headers.get("location")).toBe("https://old.example/");
  });

  it("keeps a link working when KV refuses a delete", async () => {
    quiet();
    const link = await createLink();
    await breakKv(link.slug);
    expect((await call(`/api/links/${link.slug}`, { method: "DELETE" })).status).toBe(503);
    expect(await apiRecord(link.slug)).not.toBeNull();
    expect((await scan(link.slug)).status).toBe(302);
  });

  it("applies concurrent edits to KV in the order they committed", async () => {
    const link = await createLink();
    await slowFirstKvWrite(link.slug);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(`/api/links/${link.slug}`, { method: "PATCH", body: { destination: `https://example.com/v${i}` } }),
      ),
    );
    expect((await kvRecord(link.slug))?.destination).toBe((await apiRecord(link.slug))?.destination);
  });

  it("never lets an edit resurrect a deleted link", async () => {
    const link = await createLink();
    await slowFirstKvWrite(link.slug);
    await Promise.all([
      call(`/api/links/${link.slug}`, { method: "PATCH", body: { destination: "https://example.com/late" } }),
      call(`/api/links/${link.slug}`, { method: "DELETE" }),
    ]);
    const stored = await kvRecord(link.slug);
    const reported = await apiRecord(link.slug);
    // Whichever ran second wins, but both stores agree.
    expect(stored?.destination ?? null).toBe(reported?.destination ?? null);
  });

  it("falls back to the Durable Object when a KV read fails", async () => {
    quiet();
    const link = await createLink({ destination: "https://example.com/fallback" });
    const broken = { ...testEnv.LINKS, get: () => Promise.reject(new Error("KV GET failed")) } as unknown as KVNamespace;
    const response = await scan(link.slug, IPHONE_SAFARI, AUSTIN, {}, { LINKS: broken });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/fallback");
  });
});

describe("abuse limits", () => {
  const hookSpy = () => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const totals = async (slug: string) =>
    ((await (await call(`/api/links/${slug}`)).json()) as { stats: { totalScans: number; filteredHits: number } }).stats;

  it("counts a device scanning twice within a minute once", async () => {
    const hooks = hookSpy();
    const link = await createLink({ webhookUrl: "https://example.com/hook" });
    const ip = nextIp();
    for (let i = 0; i < 3; i++) {
      expect((await scan(link.slug, IPHONE_SAFARI, AUSTIN, { "cf-connecting-ip": ip })).status).toBe(302);
    }
    expect(await totals(link.slug)).toMatchObject({ totalScans: 1, filteredHits: 2 });
    expect(hooks).toHaveBeenCalledTimes(1);
  });

  it("caps counted scans per network, even when the user agent rotates", async () => {
    hookSpy();
    const link = await createLink({ webhookUrl: "https://example.com/hook" });
    const ip = nextIp();
    for (let i = 0; i < NETWORK_MAX_SCANS + 3; i++) {
      await scan(link.slug, `${IPHONE_SAFARI} rotate/${i}`, AUSTIN, { "cf-connecting-ip": ip });
    }
    expect(await totals(link.slug)).toMatchObject({ totalScans: NETWORK_MAX_SCANS, filteredHits: 3 });
  });

  it("treats every address in an IPv6 /64 as one network", async () => {
    const link = await createLink();
    for (let i = 0; i < NETWORK_MAX_SCANS + 2; i++) {
      await scan(link.slug, `${ANDROID_CHROME} v/${i}`, AUSTIN, { "cf-connecting-ip": `2001:db8:1:2::${(i + 1).toString(16)}` });
    }
    expect((await totals(link.slug)).totalScans).toBe(NETWORK_MAX_SCANS);
  });

  it("caps alerts per link per hour and reports the held-back count when they resume", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 5, 1, 12), toFake: ["Date"] });
    const hooks = hookSpy();
    const link = await createLink({ webhookUrl: "https://example.com/hook" });
    for (let i = 0; i < ALERT_MAX + 2; i++) await scan(link.slug);
    expect(hooks).toHaveBeenCalledTimes(ALERT_MAX);
    expect((await totals(link.slug)).totalScans).toBe(ALERT_MAX + 2);

    vi.setSystemTime(Date.UTC(2026, 5, 1, 13, 0, 1));
    await scan(link.slug);
    expect(hooks).toHaveBeenCalledTimes(ALERT_MAX + 1);
    const event = JSON.parse(String(hooks.mock.calls.at(-1)![1]?.body));
    expect(event).toMatchObject({ totalScans: ALERT_MAX + 3, suppressedAlerts: 2 });
  });

  it("forgets abuse windows when scans are reset", async () => {
    const link = await createLink();
    const ip = nextIp();
    await scan(link.slug, IPHONE_SAFARI, AUSTIN, { "cf-connecting-ip": ip });
    await call(`/api/links/${link.slug}/scans`, { method: "DELETE" });
    await scan(link.slug, IPHONE_SAFARI, AUSTIN, { "cf-connecting-ip": ip });
    expect((await totals(link.slug)).totalScans).toBe(1);
  });
});

describe("routing and configuration", () => {
  it("rejects destinations on the Worker's own domain", async () => {
    for (const destination of [`${ORIGIN}/loop`, "https://go.example.com/x"]) {
      const response = await call("/api/links", {
        method: "POST",
        body: { slug: uniqueSlug(), destination },
        env: { BASE_URL: "https://go.example.com" },
      });
      expect(response.status, destination).toBe(400);
    }
    const link = await createLink();
    const patch = await call(`/api/links/${link.slug}`, { method: "PATCH", body: { destination: `${ORIGIN}/${link.slug}` } });
    expect(patch.status).toBe(400);
  });

  it("uses only the origin of BASE_URL", async () => {
    quiet();
    const response = await call("/api/links", {
      method: "POST",
      body: { slug: uniqueSlug(), destination: "https://example.com" },
      env: { BASE_URL: "https://go.example.com/sub/path" },
    });
    const link = (await response.json()) as { slug: string; shortUrl: string };
    expect(link.shortUrl).toBe(`https://go.example.com/${link.slug}`);
  });

  it("redirects with a trailing slash", async () => {
    const link = await createLink();
    expect((await call(`/${link.slug}/`, { auth: false, headers: { "user-agent": IPHONE_SAFARI } })).status).toBe(302);
  });

  it("does not ask for credentials on unknown /api paths", async () => {
    expect((await call("/api/nothing-here", { auth: false })).status).toBe(404);
    expect((await call("/api/qr/admin", { auth: false })).status).toBe(404);
  });

  it("counts scans from in-app browsers that can scan QR codes", async () => {
    const link = await createLink();
    await scan(
      link.slug,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]",
    );
    await scan(
      link.slug,
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 Telegram-Android/11.2.0",
    );
    await scan(link.slug, "QRScanner/2.1 CFNetwork/1494.0.7 Darwin/23.4.0");
    const stats = ((await (await call(`/api/links/${link.slug}`)).json()) as { stats: { totalScans: number; automatedHits: number } })
      .stats;
    expect(stats).toMatchObject({ totalScans: 2, automatedHits: 1 });
  });
});
