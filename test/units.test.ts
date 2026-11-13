import jsQR from "jsqr";
import { describe, expect, it, vi } from "vitest";
import { describeScan, formatDevice, formatLocation, isAutomated, networkKey, parseUserAgent } from "../src/analytics";
import { generateSlug, normalizeSlug, parseCreateInput, parseDestination, parsePatchInput, parseWebhookUrl } from "../src/links";
import { contrastRatio, DEFAULT_QR_STYLE, parseColor, parseQrStyle, qrModules, renderPng, renderSvg } from "../src/qr";
import { buildWebhookRequest, notifyScan, signPayload, webhookKind, type ScanNotification } from "../src/webhook";
import { ANDROID_CHROME, IPHONE_SAFARI, readQr } from "./helpers";

describe("links", () => {
  it("normalizes and validates slugs", () => {
    expect(normalizeSlug(" Austin-Roofer-01 ")).toEqual({ ok: true, value: "austin-roofer-01" });
    for (const bad of ["", "-a", "a-", "a_b", "a b", "a".repeat(65), "api", "has.dot"]) {
      expect(normalizeSlug(bad).ok, bad).toBe(false);
    }
  });

  it("accepts only absolute http(s) destinations", () => {
    expect(parseDestination("https://example.com")).toEqual({ ok: true, value: "https://example.com/" });
    for (const bad of ["javascript:alert(1)", "ftp://example.com", "/relative", "", 42, `https://x.com/${"a".repeat(2050)}`]) {
      expect(parseDestination(bad).ok).toBe(false);
    }
  });

  it("requires https webhooks except on localhost", () => {
    expect(parseWebhookUrl("https://hooks.slack.com/services/x").ok).toBe(true);
    expect(parseWebhookUrl("http://127.0.0.1:8799/hook").ok).toBe(true);
    expect(parseWebhookUrl("http://example.com/hook").ok).toBe(false);
    expect(parseWebhookUrl(null)).toEqual({ ok: true, value: null });
  });

  it("rejects unknown fields and empty patches", () => {
    expect(parseCreateInput({ destination: "https://a.com", color: "red" }).ok).toBe(false);
    expect(parseCreateInput([]).ok).toBe(false);
    expect(parsePatchInput({}).ok).toBe(false);
    const slugPatch = parsePatchInput({ slug: "new" });
    expect(slugPatch.ok === false && slugPatch.error).toMatch(/cannot be changed/);
  });

  it("collapses whitespace in labels", () => {
    const input = parseCreateInput({ destination: "https://a.com", label: "  Barton\n\nCreek  " });
    expect(input.ok && input.value.label).toBe("Barton Creek");
  });

  it("generates unambiguous slugs", () => {
    const slugs = new Set(Array.from({ length: 200 }, () => generateSlug()));
    expect(slugs.size).toBe(200);
    for (const slug of slugs) expect(slug).toMatch(/^[a-hj-km-np-z2-9]{7}$/);
  });
});

describe("analytics", () => {
  it("parses common phone and desktop user agents", () => {
    expect(parseUserAgent(IPHONE_SAFARI)).toEqual({ os: "iOS", browser: "Safari", deviceType: "mobile" });
    expect(parseUserAgent(ANDROID_CHROME)).toEqual({ os: "Android", browser: "Chrome", deviceType: "mobile" });
    expect(
      parseUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/340.0.0 Mobile/15E148 Safari/604",
      ).browser,
    ).toBe("Google app");
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36",
      ).browser,
    ).toBe("Samsung Internet");
    expect(
      parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1"),
    ).toEqual({ os: "iPadOS", browser: "Chrome", deviceType: "tablet" });
    expect(parseUserAgent("")).toEqual({ os: "Unknown", browser: "Unknown", deviceType: "unknown" });
  });

  it("flags bots, link previews and prefetches but not phones", () => {
    const req = (ua: string | null, headers: Record<string, string> = {}) =>
      new Request("https://x.test/a", { headers: { ...(ua ? { "user-agent": ua } : {}), ...headers } });
    expect(isAutomated(req(IPHONE_SAFARI))).toBe(false);
    expect(isAutomated(req(ANDROID_CHROME))).toBe(false);
    expect(isAutomated(req("Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36"))).toBe(false);
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "facebookexternalhit/1.1 Facebot Twitterbot/1.0",
      "WhatsApp/2.23.20.0",
      "curl/8.4.0",
      "python-requests/2.31",
    ]) {
      expect(isAutomated(req(ua)), ua).toBe(true);
    }
    expect(isAutomated(req(null))).toBe(true);
    expect(isAutomated(req(IPHONE_SAFARI, { "sec-purpose": "prefetch;prerender" }))).toBe(true);
  });

  it("keys IPv4 by address and IPv6 by /64", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("2001:db8:1:2::abcd")).toBe("2001:db8:1:2::/64");
    expect(networkKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(networkKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkKey("::1")).toBe("0:0:0:0::/64");
    expect(networkKey(null)).toBe("unknown");
  });

  it("formats locations the way people read them", () => {
    expect(formatLocation({ city: "Austin", region: "TX", country: "US" })).toBe("Austin, TX");
    expect(formatLocation({ city: "Toronto", region: "ON", country: "CA" })).toBe("Toronto, ON, CA");
    expect(formatLocation({ city: null, region: null, country: "US" })).toBe("US");
    expect(formatLocation({ city: null, region: null, country: null })).toBe("Unknown location");
    expect(formatDevice({ os: "iOS", browser: "Safari" })).toBe("iOS Safari");
  });

  it("uses state codes in the US and region names elsewhere", () => {
    const us = describeScan(new Request("https://x.test", { cf: { city: "Austin", region: "Texas", regionCode: "TX", country: "US" } } as RequestInit));
    expect([us.city, us.region, us.country]).toEqual(["Austin", "TX", "US"]);
    const gb = describeScan(new Request("https://x.test", { cf: { city: "London", region: "England", regionCode: "ENG", country: "GB" } } as RequestInit));
    expect(gb.region).toBe("England");
    const unknown = describeScan(new Request("https://x.test", { cf: { country: "XX" } } as RequestInit));
    expect(unknown.country).toBeNull();
  });
});

const notification: ScanNotification = {
  link: {
    slug: "austin-roofer-01",
    destination: "https://myagency.com",
    label: "Barton Creek Roofing Postcard",
    webhookUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  shortUrl: "https://qr.example.com/austin-roofer-01",
  totalScans: 1,
  scan: { ts: Date.UTC(2026, 0, 2), city: "Austin", region: "TX", country: "US", os: "iOS", browser: "Safari", deviceType: "mobile" },
};

describe("webhooks", () => {
  it("detects Discord and Slack by URL", () => {
    expect(webhookKind("https://discord.com/api/webhooks/1/abc")).toBe("discord");
    expect(webhookKind("https://discordapp.com/api/webhooks/1/abc")).toBe("discord");
    expect(webhookKind("https://discord.com/channels/1")).toBe("json");
    expect(webhookKind("https://hooks.slack.com/services/T/B/X")).toBe("slack");
    expect(webhookKind("https://example.com/hook")).toBe("json");
  });

  it("formats a Discord message that cannot ping anyone", async () => {
    const { body } = await buildWebhookRequest("https://discord.com/api/webhooks/1/abc", {
      ...notification,
      link: { ...notification.link, label: "@everyone *bold* [link](https://evil.test)" },
    });
    const payload = JSON.parse(body);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.flags).toBe(4);
    expect(payload.content).toContain("📬 **Physical QR scanned!**");
    expect(payload.content).toContain("\\*bold\\* \\[link\\](https://evil.test)");
    expect(payload.content).toContain("**Location:** Austin, TX · **Device:** iOS Safari · **Total scans:** 1");
  });

  it("formats a Slack message with escaped label", async () => {
    const { body } = await buildWebhookRequest("https://hooks.slack.com/services/T/B/X", {
      ...notification,
      link: { ...notification.link, label: "Smith & Sons <Roofing>" },
    });
    const payload = JSON.parse(body);
    expect(payload.text).toBe(
      "📬 *Physical QR scanned!*\n*Campaign:* Smith &amp; Sons &lt;Roofing&gt; (`/austin-roofer-01`)\n*Location:* Austin, TX · *Device:* iOS Safari · *Total scans:* 1",
    );
    expect([payload.unfurl_links, payload.unfurl_media]).toEqual([false, false]);
  });

  it("notes alerts held back by the hourly limit", async () => {
    const { body } = await buildWebhookRequest("https://hooks.slack.com/services/T/B/X", { ...notification, suppressedAlerts: 3 });
    expect(JSON.parse(body).text).toMatch(/\n\(3 more scans arrived while alerts were paused for this link\.\)$/);
  });

  it("signs generic JSON events when a secret is set", async () => {
    const now = Date.UTC(2026, 0, 2, 12);
    const { body, headers } = await buildWebhookRequest("https://example.com/hook", notification, "s3cret", now);
    const event = JSON.parse(body);
    expect(event).toMatchObject({ type: "qr.scanned", slug: "austin-roofer-01", totalScans: 1, location: { display: "Austin, TX" } });
    expect(headers["x-qr-track-timestamp"]).toBe(String(now / 1000));
    expect(headers["x-qr-track-signature"]).toBe(`sha256=${await signPayload("s3cret", String(now / 1000), body)}`);
    const unsigned = await buildWebhookRequest("https://example.com/hook", notification);
    expect(unsigned.headers["x-qr-track-signature"]).toBeUndefined();
  });

  it("retries once on 429 or 5xx, never on 4xx, and never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await notifyScan("https://example.com/hook", notification, undefined, flaky)).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);

    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("gone", { status: 404 }));
    expect(await notifyScan("https://example.com/hook", notification, undefined, rejected)).toBe(false);
    expect(rejected).toHaveBeenCalledTimes(1);

    const broken = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));
    expect(await notifyScan("https://example.com/hook", notification, undefined, broken)).toBe(false);
  });
});

describe("qr", () => {
  it("parses hex colours and transparency", () => {
    expect(parseColor("000")).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(parseColor("#1a2B3c")).toEqual({ r: 26, g: 43, b: 60, a: 255 });
    expect(parseColor("ffffff80")).toEqual({ r: 255, g: 255, b: 255, a: 128 });
    expect(parseColor("transparent")?.a).toBe(0);
    expect(parseColor("red")).toBeNull();
  });

  it("rejects colour pairs too faint to scan once printed", () => {
    expect(contrastRatio(parseColor("000")!, parseColor("fff")!)).toBeCloseTo(21, 0);
    expect(parseQrStyle(new URLSearchParams("fg=cccccc")).ok).toBe(false);
    expect(parseQrStyle(new URLSearchParams("fg=0b3d2e&bg=f5f0e6")).ok).toBe(true);
    expect(parseQrStyle(new URLSearchParams("bg=transparent")).ok).toBe(true);
    expect(parseQrStyle(new URLSearchParams("fg=transparent")).ok).toBe(false);
  });

  it("validates numeric options", () => {
    expect(parseQrStyle(new URLSearchParams("size=63")).ok).toBe(false);
    expect(parseQrStyle(new URLSearchParams("size=4097")).ok).toBe(false);
    expect(parseQrStyle(new URLSearchParams("margin=17")).ok).toBe(false);
    expect(parseQrStyle(new URLSearchParams("margin=1.5")).ok).toBe(false);
    expect(parseQrStyle(new URLSearchParams("ecc=x")).ok).toBe(false);
    const style = parseQrStyle(new URLSearchParams("ecc=h&margin=0&size=256"));
    expect(style.ok && [style.value.ecc, style.value.margin, style.value.size]).toEqual(["H", 0, 256]);
  });

  it("renders an SVG with a quiet zone and one path", () => {
    const text = "https://qr.example.com/austin-roofer-01";
    const count = qrModules(text, "M").length;
    const svg = renderSvg(text, DEFAULT_QR_STYLE);
    expect(svg).toContain(`viewBox="0 0 ${count + 8} ${count + 8}"`);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain("<title>QR code for https://qr.example.com/austin-roofer-01</title>");
    const transparent = renderSvg(text, { ...DEFAULT_QR_STYLE, background: { r: 255, g: 255, b: 255, a: 0 } });
    expect(transparent).not.toContain("<rect");
  });

  it("requires an opaque foreground darker than the background", () => {
    expect(parseQrStyle(new URLSearchParams("fg=00000080")).ok).toBe(false);
    expect(parseQrStyle(new URLSearchParams("fg=ffffff20&bg=000000")).ok).toBe(false);
    const inverted = parseQrStyle(new URLSearchParams("fg=ffffff&bg=000000"));
    expect(inverted.ok === false && inverted.error).toMatch(/darker than bg/);
    expect(parseQrStyle(new URLSearchParams("fg=000000&bg=ffffff80")).ok).toBe(true);
  });

  it("caps PNG size lower than SVG size", () => {
    expect(parseQrStyle(new URLSearchParams("size=4096"), "svg").ok).toBe(true);
    expect(parseQrStyle(new URLSearchParams("size=4096"), "png").ok).toBe(false);
    expect(parseQrStyle(new URLSearchParams("size=2048"), "png").ok).toBe(true);
  });

  it("renders SVGs whose path decodes back to the same URL", () => {
    const text = "https://qr.example.com/austin-roofer-01";
    for (const style of [DEFAULT_QR_STYLE, { ...DEFAULT_QR_STYLE, ecc: "H" as const, margin: 1 }]) {
      const svg = renderSvg(text, style);
      const total = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)![1]);
      const grid = Array.from({ length: total }, () => new Array<boolean>(total).fill(false));
      const path = /<path [^>]*d="([^"]*)"/.exec(svg)![1]!;
      for (const [, x, y, run, back] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
        expect(back).toBe(run);
        for (let i = 0; i < Number(run); i++) grid[Number(y)]![Number(x) + i] = true;
      }
      const modules = qrModules(text, style.ecc);
      expect(total).toBe(modules.length + style.margin * 2);
      for (let y = 0; y < total; y++) {
        for (let x = 0; x < total; x++) {
          const inside = y >= style.margin && x >= style.margin && y < total - style.margin && x < total - style.margin;
          expect(grid[y]![x]).toBe(inside ? modules[y - style.margin]![x - style.margin] : false);
        }
      }
      // Rasterize the parsed path at 8 px per module and read it like a phone would.
      const scale = 8;
      const width = total * scale;
      const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
      for (let py = 0; py < width; py++) {
        for (let px = 0; px < width; px++) {
          if (grid[Math.floor(py / scale)]![Math.floor(px / scale)]) rgba.fill(0, (py * width + px) * 4, (py * width + px) * 4 + 3);
        }
      }
      expect(jsQR(rgba, width, width)?.data).toBe(text);
    }
  });

  it("renders PNGs that decode back to the same URL", async () => {
    const text = "https://qr.example.com/austin-roofer-01";
    for (const style of [
      DEFAULT_QR_STYLE,
      { ...DEFAULT_QR_STYLE, ecc: "H" as const, margin: 2, size: 200 },
      { ...DEFAULT_QR_STYLE, foreground: parseColor("0b3d2e")!, background: parseColor("transparent")! },
    ]) {
      expect(await readQr(await renderPng(text, style))).toBe(text);
    }
  });
});
