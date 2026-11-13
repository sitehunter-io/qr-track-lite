import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  ANDROID_CHROME,
  AUSTIN,
  call,
  createLink,
  IPHONE_SAFARI,
  nextIp,
  ORIGIN,
  readQr,
  scan,
  testEnv,
  uniqueSlug,
} from "./helpers";

type Stats = {
  totalScans: number;
  automatedHits: number;
  firstScanAt: string | null;
  lastScanAt: string | null;
  recent: Array<{ location: string; os: string; browser: string }>;
  daily: Array<{ date: string; scans: number }>;
  locations: Array<{ location: string; scans: number }>;
  devices: Array<{ os: string; browser: string; scans: number }>;
};

async function stats(slug: string): Promise<Stats> {
  const response = await call(`/api/links/${slug}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { stats: Stats }).stats;
}

/** Captures outbound webhook calls; everything else (KV, Durable Objects) does not go through fetch. */
function captureWebhooks(response: () => Response = () => new Response(null, { status: 204 })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
}

afterEach(() => vi.restoreAllMocks());

describe("public routes", () => {
  it("serves a health line and blocks crawlers", async () => {
    expect((await call("/", { auth: false })).status).toBe(200);
    expect(await (await call("/robots.txt", { auth: false })).text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("returns 404 for unknown and malformed slugs", async () => {
    for (const path of ["/does-not-exist", "/Bad_Slug", "/api"]) {
      const response = await call(path, { auth: false });
      expect(response.status, path).not.toBe(302);
    }
  });
});

describe("authentication", () => {
  it("rejects missing and wrong tokens", async () => {
    const missing = await call("/api/links", { auth: false });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect((await call("/api/links", { auth: "wrong-token-0123456789" })).status).toBe(401);
  });

  it("fails closed when ADMIN_SECRET is missing or too short", async () => {
    for (const secret of [undefined, "short"]) {
      const response = await call("/api/links", { auth: secret ?? "anything", env: { ADMIN_SECRET: secret } });
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("admin_secret_missing");
    }
  });

  it("leaves QR images public", async () => {
    const link = await createLink();
    expect((await call(`/api/qr/${link.slug}.svg`, { auth: false })).status).toBe(200);
  });
});

describe("creating links", () => {
  it("returns the short URL, QR URLs and an inline SVG", async () => {
    const slug = uniqueSlug("Austin-Roofer");
    const response = await call("/api/links", {
      method: "POST",
      body: { slug, destination: "https://myagency.com", label: "Barton Creek Roofing Postcard" },
    });
    expect(response.status).toBe(201);
    const link = (await response.json()) as Record<string, unknown>;
    const lower = slug.toLowerCase();
    expect(link).toMatchObject({
      slug: lower,
      shortUrl: `${ORIGIN}/${lower}`,
      destination: "https://myagency.com/",
      label: "Barton Creek Roofing Postcard",
      webhookUrl: null,
      qr: { svg: `${ORIGIN}/api/qr/${lower}.svg`, png: `${ORIGIN}/api/qr/${lower}.png` },
    });
    expect(String(link.svg)).toMatch(/^<svg /);
  });

  it("refuses a taken slug regardless of case", async () => {
    const link = await createLink();
    const again = await call("/api/links", {
      method: "POST",
      body: { slug: link.slug.toUpperCase(), destination: "https://other.example" },
    });
    expect(again.status).toBe(409);
  });

  it("gives exactly one winner when the same slug is created concurrently", async () => {
    const slug = uniqueSlug("race");
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call("/api/links", { method: "POST", body: { slug, destination: `https://example.com/${i}` } }),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it("generates a slug when none is given", async () => {
    const response = await call("/api/links", { method: "POST", body: { destination: "https://example.com" } });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { slug: string }).slug).toMatch(/^[a-z2-9]{7}$/);
  });

  it("validates input", async () => {
    const cases: Array<[unknown, string]> = [
      ["not json", "invalid_body"],
      [{ destination: "javascript:alert(1)" }, "invalid_input"],
      [{ destination: "https://example.com", slug: "api" }, "invalid_input"],
      [{ destination: "https://example.com", webhookUrl: "http://example.com/hook" }, "invalid_input"],
      [{ destination: "https://example.com", surprise: true }, "invalid_input"],
    ];
    for (const [body, code] of cases) {
      const response = await call("/api/links", { method: "POST", body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it("uses BASE_URL for short links and QR content when set", async () => {
    const env = { BASE_URL: "https://go.example.com/" };
    const response = await call("/api/links", {
      method: "POST",
      body: { slug: uniqueSlug(), destination: "https://example.com" },
      env,
    });
    const link = (await response.json()) as { slug: string; shortUrl: string };
    expect(link.shortUrl).toBe(`https://go.example.com/${link.slug}`);
    const png = await call(`/api/qr/${link.slug}.png?size=256`, { auth: false, env });
    expect(await readQr(new Uint8Array(await png.arrayBuffer()))).toBe(link.shortUrl);
  });
});

describe("scanning", () => {
  it("redirects with 302 and no caching", async () => {
    const link = await createLink({ destination: "https://example.com/roofing?utm_source=postcard" });
    const response = await scan(link.slug);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/roofing?utm_source=postcard");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("counts human scans with location and device", async () => {
    const link = await createLink();
    await scan(link.slug, IPHONE_SAFARI, AUSTIN);
    await scan(link.slug.toUpperCase(), ANDROID_CHROME, { city: "Toronto", region: "Ontario", regionCode: "ON", country: "CA" });
    const s = await stats(link.slug);
    expect(s.totalScans).toBe(2);
    expect(s.automatedHits).toBe(0);
    expect(s.recent.map((r) => [r.location, r.os, r.browser])).toEqual([
      ["Toronto, ON, CA", "Android", "Chrome"],
      ["Austin, TX", "iOS", "Safari"],
    ]);
    expect(s.daily).toHaveLength(30);
    expect(s.daily.at(-1)).toEqual({ date: new Date().toISOString().slice(0, 10), scans: 2 });
    expect(s.locations.map((l) => l.location).sort()).toEqual(["Austin, TX", "Toronto, ON, CA"]);
    expect(s.firstScanAt).not.toBeNull();
    expect(s.lastScanAt! >= s.firstScanAt!).toBe(true);
  });

  it("does not count HEAD requests, bots or prefetches", async () => {
    const hooks = captureWebhooks();
    const link = await createLink({ webhookUrl: "https://example.com/hook" });
    expect((await call(`/${link.slug}`, { method: "HEAD", auth: false })).status).toBe(302);
    await scan(link.slug, "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)");
    await scan(link.slug, "facebookexternalhit/1.1");
    await scan(link.slug, IPHONE_SAFARI, AUSTIN, { "sec-purpose": "prefetch" });
    const s = await stats(link.slug);
    expect(s.totalScans).toBe(0);
    expect(s.automatedHits).toBe(3);
    expect(hooks).not.toHaveBeenCalled();
  });

  it("counts concurrent scans exactly", async () => {
    const link = await createLink();
    const contexts = Array.from({ length: 25 }, () => createExecutionContext());
    await Promise.all(
      contexts.map((ctx) =>
        worker.fetch(
          new Request(`${ORIGIN}/${link.slug}`, {
            headers: { "user-agent": IPHONE_SAFARI, "cf-connecting-ip": nextIp() },
            cf: AUSTIN,
          } as RequestInit),
          testEnv,
          ctx,
        ),
      ),
    );
    await Promise.all(contexts.map((ctx) => waitOnExecutionContext(ctx)));
    expect((await stats(link.slug)).totalScans).toBe(25);
  });

  it("sends a Discord notification with the running total", async () => {
    const hooks = captureWebhooks();
    const link = await createLink({
      label: "Barton Creek Roofing Postcard",
      webhookUrl: "https://discord.com/api/webhooks/123/token",
    });
    await scan(link.slug);
    await scan(link.slug);
    expect(hooks).toHaveBeenCalledTimes(2);
    const [url, init] = hooks.mock.calls[1]!;
    expect(url).toBe("https://discord.com/api/webhooks/123/token");
    const { content } = JSON.parse(String(init?.body));
    expect(content).toBe(
      `📬 **Physical QR scanned!**\n**Campaign:** Barton Creek Roofing Postcard (\`/${link.slug}\`)\n**Location:** Austin, TX · **Device:** iOS Safari · **Total scans:** 2`,
    );
  });

  it("falls back to DEFAULT_WEBHOOK_URL and signs JSON events", async () => {
    const hooks = captureWebhooks();
    const link = await createLink();
    await call(`/${link.slug}`, {
      auth: false,
      headers: { "user-agent": IPHONE_SAFARI },
      cf: AUSTIN,
      env: { DEFAULT_WEBHOOK_URL: "https://example.com/all-scans" },
    });
    expect(hooks).toHaveBeenCalledTimes(1);
    const [url, init] = hooks.mock.calls[0]!;
    expect(url).toBe("https://example.com/all-scans");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-qr-track-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({ type: "qr.scanned", slug: link.slug, totalScans: 1 });
  });

  it("still redirects and counts when the webhook is down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const link = await createLink({ webhookUrl: "https://example.com/hook" });
    expect((await scan(link.slug)).status).toBe(302);
    expect((await stats(link.slug)).totalScans).toBe(1);
  });
});

describe("managing links", () => {
  it("updates the destination and clears the webhook", async () => {
    const hooks = captureWebhooks();
    const link = await createLink({ webhookUrl: "https://example.com/hook" });
    const response = await call(`/api/links/${link.slug}`, {
      method: "PATCH",
      body: { destination: "https://example.com/new", webhookUrl: null, label: "Reprint" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ destination: "https://example.com/new", webhookUrl: null, label: "Reprint" });
    expect((await scan(link.slug)).headers.get("location")).toBe("https://example.com/new");
    expect(hooks).not.toHaveBeenCalled();
  });

  it("rejects bad patches", async () => {
    const link = await createLink();
    expect((await call(`/api/links/${link.slug}`, { method: "PATCH", body: { slug: "other" } })).status).toBe(400);
    expect((await call(`/api/links/${link.slug}`, { method: "PATCH", body: {} })).status).toBe(400);
    expect((await call("/api/links/missing-link", { method: "PATCH", body: { label: "x" } })).status).toBe(404);
  });

  it("resets scan counts after a test scan, keeping the link", async () => {
    const link = await createLink();
    await scan(link.slug);
    await scan(link.slug, "curl/8.4.0");
    expect((await call(`/api/links/${link.slug}/scans`, { method: "DELETE" })).status).toBe(200);
    const s = await stats(link.slug);
    expect([s.totalScans, s.automatedHits, s.recent.length, s.firstScanAt]).toEqual([0, 0, 0, null]);
    expect((await scan(link.slug)).status).toBe(302);
    expect((await stats(link.slug)).totalScans).toBe(1);
  });

  it("deletes a link and its history, and frees the slug", async () => {
    const link = await createLink();
    await scan(link.slug);
    expect((await call(`/api/links/${link.slug}`, { method: "DELETE" })).status).toBe(200);
    expect((await scan(link.slug)).status).toBe(404);
    expect((await call(`/api/links/${link.slug}`)).status).toBe(404);
    expect((await call(`/api/links/${link.slug}`, { method: "DELETE" })).status).toBe(404);

    const again = await call("/api/links", { method: "POST", body: { slug: link.slug, destination: "https://example.com" } });
    expect(again.status).toBe(201);
    expect((await stats(link.slug)).totalScans).toBe(0);
  });

  it("lists links with totals across pages", async () => {
    const created = [await createLink(), await createLink(), await createLink()];
    await scan(created[0]!.slug);
    const seen = new Map<string, number>();
    let cursor: string | null = null;
    do {
      const response = await call(`/api/links?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const page = (await response.json()) as { links: Array<{ slug: string; totalScans: number }>; cursor: string | null };
      expect(page.links.length).toBeLessThanOrEqual(2);
      for (const link of page.links) {
        expect(seen.has(link.slug)).toBe(false);
        seen.set(link.slug, link.totalScans);
      }
      cursor = page.cursor;
    } while (cursor);
    expect(created.map((link) => seen.get(link.slug))).toEqual([1, 0, 0]);
  });
});

describe("QR images", () => {
  it("serves SVG and PNG that encode the short link", async () => {
    const link = await createLink();
    const svg = await call(`/api/qr/${link.slug}.svg?fg=0b3d2e&bg=f5f0e6`, { auth: false });
    expect(svg.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(svg.headers.get("x-qr-content")).toBe(link.shortUrl);
    expect(await svg.text()).toContain('fill="#0b3d2e"');

    const png = await call(`/api/qr/${link.slug}.png?size=300&ecc=Q`, { auth: false });
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("access-control-allow-origin")).toBe("*");
    expect(await readQr(new Uint8Array(await png.arrayBuffer()))).toBe(link.shortUrl);
  });

  it("offers a download filename", async () => {
    const link = await createLink();
    const response = await call(`/api/qr/${link.slug}.svg?download`, { auth: false });
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${link.slug}.svg"`);
  });

  it("404s for unknown links and rejects bad options", async () => {
    const link = await createLink();
    expect((await call("/api/qr/no-such-link.svg", { auth: false })).status).toBe(404);
    expect((await call(`/api/qr/${link.slug}.gif`, { auth: false })).status).toBe(404);
    expect((await call(`/api/qr/${link.slug}.png?fg=eeeeee`, { auth: false })).status).toBe(400);
  });
});
