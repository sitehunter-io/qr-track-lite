import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeScan, isAutomated } from "./analytics";
import type { Env } from "./env";
import {
  generateSlug,
  KV_PREFIX,
  kvKey,
  normalizeSlug,
  parseCreateInput,
  parsePatchInput,
  parseWebhookUrl,
  type LinkRecord,
  type Result,
} from "./links";
import { DEFAULT_QR_STYLE, parseQrStyle, renderPng, renderSvg } from "./qr";
import { notifyScan, webhookKind } from "./webhook";

export { ScanCounter } from "./counter";

type AppEnv = { Bindings: Env };
type AppContext = Context<AppEnv>;

// strict: false so a trailing slash (/austin-roofer-01/) still resolves.
const app = new Hono<AppEnv>({ strict: false });

const MAX_BODY_BYTES = 16_384;
const MIN_SECRET_LENGTH = 16;

const counter = (env: Env, slug: string) => env.SCANS.get(env.SCANS.idFromName(slug));

function apiError(c: AppContext, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

const storageBusy = (c: AppContext) =>
  apiError(c, 503, "storage_busy", "Storage refused the write (KV allows one write per second per link). Nothing changed; retry in a moment.");

/** Public origin for short links: BASE_URL's origin when set, otherwise the origin of this request. */
function baseUrl(c: AppContext): string {
  const configured = c.env.BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.pathname !== "/") {
        console.warn(JSON.stringify({ message: "BASE_URL path ignored; short links live at the root of the origin" }));
      }
      return url.origin;
    } catch {
      console.warn(JSON.stringify({ message: "BASE_URL is not a valid URL; using the request origin" }));
    }
  }
  return new URL(c.req.url).origin;
}

/** A destination on this Worker's own origin would redirect back into the Worker (a loop, or a 404). */
function pointsAtSelf(c: AppContext, destination: string): boolean {
  const target = new URL(destination).origin;
  return target === baseUrl(c) || target === new URL(c.req.url).origin;
}

function linkView(link: LinkRecord, base: string) {
  return {
    slug: link.slug,
    shortUrl: `${base}/${link.slug}`,
    destination: link.destination,
    label: link.label,
    webhookUrl: link.webhookUrl,
    webhookKind: link.webhookUrl ? webhookKind(link.webhookUrl) : null,
    qr: {
      svg: `${base}/api/qr/${link.slug}.svg`,
      png: `${base}/api/qr/${link.slug}.png`,
    },
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

async function readJson(c: AppContext): Promise<Result<unknown>> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, error: "Request body is too large." };
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: "Request body is too large." };
  if (!text.trim()) return { ok: false, error: "Request body must be a JSON object." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "Request body is not valid JSON." };
  }
}

/** Compares SHA-256 digests in constant time, so neither length nor content leaks through timing. */
async function secretsMatch(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function slugParam(c: AppContext): string | null {
  const parsed = normalizeSlug(c.req.param("slug") ?? "");
  return parsed.ok ? parsed.value : null;
}

const linkNotFound = (c: AppContext, slug: string) => apiError(c, 404, "not_found", `No link with slug "${slug}".`);

// --- Public ------------------------------------------------------------------

app.get("/", (c) => c.text("qr-track-lite is running. See /api/links (authenticated) to create tracked links.\n"));

// Keep crawlers off the short links; their hits are not scans.
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

app.get("/favicon.ico", () => new Response(null, { status: 204 }));

app.get("/api/qr/:file", async (c) => {
  const match = /^([a-z0-9-]{1,64})\.(svg|png)$/i.exec(c.req.param("file"));
  const slug = match ? normalizeSlug(match[1]) : null;
  if (!match || !slug?.ok) return apiError(c, 404, "not_found", "Use /api/qr/<slug>.svg or /api/qr/<slug>.png.");
  if ((await c.env.LINKS.get(kvKey(slug.value))) === null) return linkNotFound(c, slug.value);

  const format = match[2]!.toLowerCase() as "svg" | "png";
  const params = new URL(c.req.url).searchParams;
  const style = parseQrStyle(params, format);
  if (!style.ok) return apiError(c, 400, "invalid_qr_options", style.error);

  const text = `${baseUrl(c)}/${slug.value}`;
  const headers = new Headers({
    "cache-control": "public, max-age=86400",
    "access-control-allow-origin": "*",
    "x-qr-content": text,
  });
  if (params.has("download")) headers.set("content-disposition", `attachment; filename="${slug.value}.${format}"`);

  if (format === "svg") {
    headers.set("content-type", "image/svg+xml; charset=utf-8");
    return new Response(renderSvg(text, style.value), { headers });
  }
  headers.set("content-type", "image/png");
  return new Response(await renderPng(text, style.value), { headers });
});

// --- Admin API ---------------------------------------------------------------

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return apiError(
      c,
      500,
      "admin_secret_missing",
      `ADMIN_SECRET is not set or is shorter than ${MIN_SECRET_LENGTH} characters. Run: npx wrangler secret put ADMIN_SECRET`,
    );
  }
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim();
  if (!token || !(await secretsMatch(token, secret))) {
    c.header("www-authenticate", 'Bearer realm="qr-track-lite"');
    return apiError(c, 401, "unauthorized", "Send Authorization: Bearer <ADMIN_SECRET>.");
  }
  await next();
};

app.use("/api/links", requireAdmin);
app.use("/api/links/*", requireAdmin);

app.post("/api/links", async (c) => {
  const body = await readJson(c);
  if (!body.ok) return apiError(c, 400, "invalid_body", body.error);
  const input = parseCreateInput(body.value);
  if (!input.ok) return apiError(c, 400, "invalid_input", input.error);
  if (pointsAtSelf(c, input.value.destination)) {
    return apiError(c, 400, "invalid_input", "destination cannot be on this Worker's own domain.");
  }

  const now = new Date().toISOString();
  const attempts = input.value.slug ? 1 : 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const slug = input.value.slug ?? generateSlug();
    const record: LinkRecord = {
      slug,
      destination: input.value.destination,
      label: input.value.label,
      webhookUrl: input.value.webhookUrl,
      createdAt: now,
      updatedAt: now,
    };
    // The Durable Object is the lock: exactly one create wins a given slug, and it publishes to KV.
    const result = await counter(c.env, slug).create(record);
    if (result.status === "unavailable") return storageBusy(c);
    if (result.status === "taken") {
      if (input.value.slug) return apiError(c, 409, "slug_taken", `The slug "${slug}" is already in use.`);
      continue;
    }
    const view = linkView(record, baseUrl(c));
    return c.json({ ...view, svg: renderSvg(view.shortUrl, DEFAULT_QR_STYLE) }, 201);
  }
  return apiError(c, 503, "slug_unavailable", "Could not find a free slug. Try again, or pass one.");
});

app.get("/api/links", async (c) => {
  const requested = Number(c.req.query("limit") ?? 50);
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
  const cursor = c.req.query("cursor") || undefined;
  const page = await c.env.LINKS.list({ prefix: KV_PREFIX, limit, cursor });
  const base = baseUrl(c);

  const links = await Promise.all(
    page.keys.map(async ({ name }) => {
      const summary = await counter(c.env, name.slice(KV_PREFIX.length)).getSummary();
      if (!summary) return null; // deleted moments ago; KV listings lag by up to a minute
      return { ...linkView(summary.link, base), totalScans: summary.totals.totalScans, lastScanAt: summary.totals.lastScanAt };
    }),
  );
  return c.json({
    links: links.filter((link) => link !== null),
    cursor: page.list_complete ? null : page.cursor,
  });
});

app.get("/api/links/:slug", async (c) => {
  const slug = slugParam(c);
  if (!slug) return linkNotFound(c, c.req.param("slug"));
  const result = await counter(c.env, slug).getStats(Date.now());
  if (!result) return linkNotFound(c, slug);
  return c.json({ ...linkView(result.link, baseUrl(c)), stats: result.stats });
});

app.patch("/api/links/:slug", async (c) => {
  const slug = slugParam(c);
  if (!slug) return linkNotFound(c, c.req.param("slug"));
  const body = await readJson(c);
  if (!body.ok) return apiError(c, 400, "invalid_body", body.error);
  const patch = parsePatchInput(body.value);
  if (!patch.ok) return apiError(c, 400, "invalid_input", patch.error);
  if (patch.value.destination && pointsAtSelf(c, patch.value.destination)) {
    return apiError(c, 400, "invalid_input", "destination cannot be on this Worker's own domain.");
  }

  const result = await counter(c.env, slug).update(patch.value, new Date().toISOString());
  if (result.status === "unavailable") return storageBusy(c);
  if (result.status === "missing") return linkNotFound(c, slug);
  return c.json(linkView(result.link, baseUrl(c)));
});

app.delete("/api/links/:slug/scans", async (c) => {
  const slug = slugParam(c);
  if (!slug) return linkNotFound(c, c.req.param("slug"));
  if (!(await counter(c.env, slug).resetScans())) return linkNotFound(c, slug);
  return c.json({ slug, reset: true });
});

app.delete("/api/links/:slug", async (c) => {
  const slug = slugParam(c);
  if (!slug) return linkNotFound(c, c.req.param("slug"));
  const result = await counter(c.env, slug).destroy(slug);
  if (result.status === "unavailable") return storageBusy(c);
  if (result.status === "missing") return linkNotFound(c, slug);
  return c.json({ slug, deleted: true });
});

// --- Redirect ----------------------------------------------------------------

const isRetryable = (error: unknown) => (error as { retryable?: boolean } | null)?.retryable === true;

async function trackScan(env: Env, request: Request, slug: string, shortUrl: string): Promise<void> {
  try {
    const scan = describeScan(request);
    const automated = isAutomated(request);
    const client = { ip: request.headers.get("cf-connecting-ip"), userAgent: request.headers.get("user-agent") ?? "" };
    let result;
    try {
      result = await counter(env, slug).recordScan(scan, automated, client);
    } catch (error) {
      // A Durable Object can reset (for example during a deploy); Cloudflare marks those errors retryable.
      if (!isRetryable(error)) throw error;
      result = await counter(env, slug).recordScan(scan, automated, client);
    }
    if (result.status !== "counted" || !result.alert) return;

    let target = result.link.webhookUrl;
    if (!target && env.DEFAULT_WEBHOOK_URL) {
      const fallback = parseWebhookUrl(env.DEFAULT_WEBHOOK_URL);
      if (fallback.ok) target = fallback.value;
      else console.warn(JSON.stringify({ message: "DEFAULT_WEBHOOK_URL ignored", reason: fallback.error }));
    }
    if (!target) return;
    await notifyScan(
      target,
      { link: result.link, shortUrl, totalScans: result.totalScans, scan, suppressedAlerts: result.alert.suppressed },
      env.WEBHOOK_SECRET,
    );
  } catch (error) {
    console.error(JSON.stringify({ message: "scan tracking failed", slug, error: String(error) }));
  }
}

async function lookupLink(env: Env, slug: string): Promise<LinkRecord | null> {
  try {
    return await env.LINKS.get<LinkRecord>(kvKey(slug), "json");
  } catch (error) {
    // KV is the fast path, not the source of truth: fall back to the link's Durable Object.
    console.error(JSON.stringify({ message: "KV read failed; asking the Durable Object", slug, error: String(error) }));
    return counter(env, slug).getLink();
  }
}

// GET and HEAD both redirect; only GET counts (HEAD is never a person scanning).
app.get("/:slug", async (c) => {
  const notFound = () => c.text("Link not found.\n", 404, { "cache-control": "no-store" });
  const slug = slugParam(c);
  if (!slug) return notFound();
  const link = await lookupLink(c.env, slug);
  if (!link) return notFound();

  if (c.req.raw.method === "GET") {
    c.executionCtx.waitUntil(trackScan(c.env, c.req.raw, slug, `${baseUrl(c)}/${slug}`));
  }
  return new Response(null, {
    status: 302,
    headers: { location: link.destination, "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
});

app.notFound((c) =>
  c.req.path.startsWith("/api/") ? apiError(c, 404, "not_found", "Not found.") : c.text("Not found.\n", 404),
);

app.onError((error, c) => {
  console.error(JSON.stringify({ message: "unhandled error", path: c.req.path, error: String(error) }));
  return apiError(c, 500, "internal_error", "Something went wrong. Check the Worker logs.");
});

export default app;
