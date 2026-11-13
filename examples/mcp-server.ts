/**
 * A tiny MCP server for qr-track-lite, so you can say things like
 * "Generate a tracked QR code for my Barton Creek Roofing postcard" in Claude or Cursor.
 *
 * Runs on Node 22.18+ with no build step (Node strips the types):
 *   QR_TRACK_URL=https://go.youragency.com \
 *   QR_TRACK_ADMIN_SECRET=... \
 *   node examples/mcp-server.ts
 */
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function readBase(): string {
  const raw = process.env.QR_TRACK_URL?.trim();
  if (!raw || !process.env.QR_TRACK_ADMIN_SECRET) {
    console.error("Set QR_TRACK_URL (your Worker URL) and QR_TRACK_ADMIN_SECRET (its ADMIN_SECRET).");
    process.exit(1);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`QR_TRACK_URL is not a valid URL: ${raw}`);
    process.exit(1);
  }
  // The admin secret travels in a header, so never send it in clear text over the internet.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    console.error("QR_TRACK_URL must use https (plain http is allowed only for localhost).");
    process.exit(1);
  }
  return url.origin;
}

const BASE = readBase();
const SECRET = process.env.QR_TRACK_ADMIN_SECRET!;

type Link = {
  slug: string;
  shortUrl: string;
  destination: string;
  label: string | null;
  webhookKind: string | null;
  totalScans?: number;
  lastScanAt?: string | null;
  stats?: {
    totalScans: number;
    automatedHits: number;
    filteredHits: number;
    lastScanAt: string | null;
    recent: Array<{ at: string; location: string; os: string; browser: string }>;
    locations: Array<{ location: string; scans: number }>;
    devices: Array<{ os: string; browser: string; scans: number }>;
  };
};

class ApiError extends Error {}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...init.headers },
  });
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new ApiError(`qr-track-lite: ${message}`);
  }
  return body as T;
}

const slugPath = (slug: string) => encodeURIComponent(slug.toLowerCase());
/** Image URLs are always built from QR_TRACK_URL, never taken from an API response. */
const qrUrl = (slug: string, format: "svg" | "png", size: number) => `${BASE}/api/qr/${slugPath(slug)}.${format}?size=${size}`;

/** Downloads a QR image, checking its type and size. */
async function fetchQr(slug: string, format: "svg" | "png", size: number): Promise<Uint8Array> {
  const response = await fetch(qrUrl(slug, format, size), { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const type = response.headers.get("content-type") ?? "";
  const expected = format === "svg" ? "image/svg+xml" : "image/png";
  if (!response.ok || !type.startsWith(expected)) throw new Error(`expected ${expected}, got HTTP ${response.status} ${type}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new Error("image too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image too large");
  return bytes;
}

/** Expands a leading ~ and insists on an absolute path, since an MCP server's working directory is unpredictable. */
function savePath(input: string): string {
  const expanded = input.replace(/^~(?=$|[\\/])/, homedir());
  if (!isAbsolute(expanded)) throw new Error(`use an absolute path or one starting with ~/ (got "${input}")`);
  return resolve(expanded);
}

const text = (value: string) => ({ type: "text" as const, text: value });
const failure = (error: unknown) => ({
  isError: true,
  content: [text(error instanceof ApiError ? error.message : `Request failed: ${String(error)}`)],
});

function describeLink(link: Link): string {
  return [
    `Short link: ${link.shortUrl}`,
    `Points to: ${link.destination}`,
    link.label ? `Label: ${link.label}` : null,
    `Scan alerts: ${link.webhookKind ? `on (${link.webhookKind})` : "off"}`,
    `Print-ready SVG: ${qrUrl(link.slug, "svg", 1024)}`,
    `PNG: ${qrUrl(link.slug, "png", 2048)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const server = new McpServer({ name: "qr-track-lite", version: "0.1.0" });

server.registerTool(
  "create_tracked_qr",
  {
    title: "Create a tracked QR code",
    description:
      "Creates a short link and a print-ready QR code for a postcard, flyer or mailer. Every scan is counted, and an optional Discord, Slack or JSON webhook is pinged on each scan.",
    inputSchema: {
      destination: z.string().describe("Where the QR code should send people (an http or https URL)."),
      label: z.string().optional().describe('Campaign name shown in scan alerts, e.g. "Barton Creek Roofing postcard".'),
      slug: z
        .string()
        .optional()
        .describe("Optional path for the short link (letters, digits, hyphens). Generated when omitted."),
      webhookUrl: z.string().optional().describe("Optional Discord, Slack or https webhook to ping on every scan."),
      saveTo: z
        .string()
        .optional()
        .describe("Optional file path ending in .svg or .png, absolute or starting with ~/. Existing files are never overwritten."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ destination, label, slug, webhookUrl, saveTo }) => {
    let link: Link;
    try {
      link = await api<Link>("/api/links", {
        method: "POST",
        body: JSON.stringify({ destination, label, slug, webhookUrl }),
      });
    } catch (error) {
      return failure(error);
    }

    // The link exists from here on, so every later problem is reported alongside it, never as a failure.
    const lines = [describeLink(link)];
    if (saveTo) {
      try {
        const path = savePath(saveTo);
        const ext = extname(path).toLowerCase();
        if (ext !== ".svg" && ext !== ".png") throw new Error("the file name must end in .svg or .png");
        // "wx" refuses to overwrite anything, including a symlink planted at the path.
        await writeFile(path, await fetchQr(link.slug, ext === ".svg" ? "svg" : "png", 2048), { flag: "wx" });
        lines.push(`Saved: ${path}`);
      } catch (error) {
        const reason = (error as NodeJS.ErrnoException).code === "EEXIST" ? "that file already exists" : String((error as Error).message ?? error);
        lines.push(`Not saved (${reason}). The link was created; download the QR code from the URLs above.`);
      }
    }

    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
    try {
      const preview = await fetchQr(link.slug, "png", 512);
      content.push({ type: "image", data: Buffer.from(preview).toString("base64"), mimeType: "image/png" });
    } catch (error) {
      lines.push(`Preview unavailable (${String((error as Error).message ?? error)}).`);
    }
    return { content: [text(lines.join("\n")), ...content] };
  },
);

server.registerTool(
  "get_qr_stats",
  {
    title: "Get QR scan stats",
    description: "Shows how many times a tracked QR code was scanned, when, where (city level) and on what devices.",
    inputSchema: { slug: z.string().describe("The short link's slug.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ slug }) => {
    try {
      const link = await api<Link>(`/api/links/${slugPath(slug)}`);
      const s = link.stats;
      if (!s) throw new ApiError("qr-track-lite: the response had no stats.");
      const ignored = s.automatedHits + s.filteredHits;
      const lines = [
        describeLink(link),
        "",
        `Scans: ${s.totalScans}${ignored ? ` (plus ${ignored} bot, link-preview or repeat hits, not counted)` : ""}`,
        `Last scan: ${s.lastScanAt ?? "never"}`,
      ];
      if (s.locations.length) lines.push(`Top locations: ${s.locations.slice(0, 5).map((l) => `${l.location} (${l.scans})`).join(", ")}`);
      if (s.devices.length) lines.push(`Devices: ${s.devices.slice(0, 5).map((d) => `${d.os} ${d.browser} (${d.scans})`).join(", ")}`);
      if (s.recent.length) {
        lines.push("Recent scans:", ...s.recent.slice(0, 5).map((r) => `- ${r.at}: ${r.location}, ${r.os} ${r.browser}`));
      }
      return { content: [text(lines.join("\n"))] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "list_tracked_qrs",
  {
    title: "List tracked QR codes",
    description: "Lists tracked QR links with their scan totals.",
    inputSchema: { cursor: z.string().optional().describe("Cursor from a previous page.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ cursor }) => {
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const page = await api<{ links: Link[]; cursor: string | null }>(`/api/links${query}`);
      if (!page.links.length) return { content: [text("No tracked QR links yet.")] };
      const lines = page.links.map(
        (l) => `- ${l.slug}${l.label ? ` (${l.label})` : ""}: ${l.totalScans ?? 0} scans, last ${l.lastScanAt ?? "never"} -> ${l.destination}`,
      );
      if (page.cursor) lines.push(`More links: call again with cursor "${page.cursor}".`);
      return { content: [text(lines.join("\n"))] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "update_tracked_qr",
  {
    title: "Update a tracked QR code",
    description:
      "Changes where an already-printed QR code points, its label, or its webhook. The printed code keeps working.",
    inputSchema: {
      slug: z.string().describe("The short link's slug."),
      destination: z.string().optional().describe("New http or https destination."),
      label: z.string().nullable().optional().describe("New label, or null to clear it."),
      webhookUrl: z.string().nullable().optional().describe("New webhook URL, or null to turn scan alerts off."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ slug, ...changes }) => {
    try {
      const link = await api<Link>(`/api/links/${slugPath(slug)}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      return { content: [text(`Updated.\n${describeLink(link)}`)] };
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());
