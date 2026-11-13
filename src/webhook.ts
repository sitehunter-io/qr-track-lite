/**
 * Scan notifications. Discord and Slack webhooks get a chat message; any other
 * URL gets a JSON event, signed with HMAC-SHA256 when WEBHOOK_SECRET is set.
 */
import { formatDevice, formatLocation, type ScanEvent } from "./analytics";
import type { LinkRecord } from "./links";

export type WebhookKind = "discord" | "slack" | "json";

export interface ScanNotification {
  link: LinkRecord;
  shortUrl: string;
  totalScans: number;
  scan: ScanEvent;
  /** Scans that got no alert because the link hit its hourly alert limit. */
  suppressedAlerts?: number;
}

export interface WebhookRequest {
  body: string;
  headers: Record<string, string>;
}

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

export function webhookKind(url: string): WebhookKind {
  try {
    const { hostname, pathname } = new URL(url);
    if (DISCORD_HOSTS.has(hostname) && pathname.startsWith("/api/webhooks/")) return "discord";
    if (hostname === "hooks.slack.com") return "slack";
  } catch {
    // fall through: treat as a generic endpoint
  }
  return "json";
}

/** Backslash-escapes Discord markdown so a label renders as plain text. */
const escapeDiscord = (text: string): string => text.replace(/[\\*_~`|<>[\]]/g, "\\$&");
/** Slack needs only &, < and > escaped in mrkdwn. */
const escapeSlack = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function chatLines(n: ScanNotification, bold: (s: string) => string, escape: (s: string) => string): string {
  const path = `\`/${n.link.slug}\``;
  const campaign = n.link.label ? `${escape(n.link.label)} (${path})` : path;
  const lines = [
    `📬 ${bold("Physical QR scanned!")}`,
    `${bold("Campaign:")} ${campaign}`,
    `${bold("Location:")} ${escape(formatLocation(n.scan))} · ${bold("Device:")} ${escape(formatDevice(n.scan))} · ${bold("Total scans:")} ${n.totalScans}`,
  ];
  const held = n.suppressedAlerts ?? 0;
  if (held > 0) lines.push(`(${held} more ${held === 1 ? "scan" : "scans"} arrived while alerts were paused for this link.)`);
  return lines.join("\n");
}

export function scanEventPayload(n: ScanNotification) {
  return {
    type: "qr.scanned",
    slug: n.link.slug,
    label: n.link.label,
    shortUrl: n.shortUrl,
    destination: n.link.destination,
    totalScans: n.totalScans,
    suppressedAlerts: n.suppressedAlerts ?? 0,
    scannedAt: new Date(n.scan.ts).toISOString(),
    location: {
      city: n.scan.city,
      region: n.scan.region,
      country: n.scan.country,
      display: formatLocation(n.scan),
    },
    device: {
      os: n.scan.os,
      browser: n.scan.browser,
      type: n.scan.deviceType,
      display: formatDevice(n.scan),
    },
  };
}

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 over `${timestamp}.${body}`, hex encoded. */
export async function signPayload(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)));
}

export async function buildWebhookRequest(
  url: string,
  n: ScanNotification,
  secret?: string,
  now: number = Date.now(),
): Promise<WebhookRequest> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "qr-track-lite",
  };
  const kind = webhookKind(url);

  if (kind === "discord") {
    const content = chatLines(n, (s) => `**${s}**`, escapeDiscord);
    // allowed_mentions: a label can never ping @everyone or a role. flags 4 (SUPPRESS_EMBEDS): no link previews.
    return {
      headers,
      body: JSON.stringify({ username: "qr-track-lite", content, allowed_mentions: { parse: [] }, flags: 4 }),
    };
  }
  if (kind === "slack") {
    const text = chatLines(n, (s) => `*${s}*`, escapeSlack);
    return { headers, body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }) };
  }

  const body = JSON.stringify(scanEventPayload(n));
  if (secret) {
    const timestamp = String(Math.floor(now / 1000));
    headers["x-qr-track-timestamp"] = timestamp;
    headers["x-qr-track-signature"] = `sha256=${await signPayload(secret, timestamp, body)}`;
  }
  return { headers, body };
}

const TIMEOUT_MS = 8_000;
const MAX_RETRY_DELAY_MS = 3_000;

function retryDelay(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  return 1_000;
}

/**
 * Sends the notification. Retries once on 429 or 5xx. Never throws: it runs
 * after the visitor has been redirected, so a failure is logged and dropped.
 */
export async function notifyScan(
  url: string,
  n: ScanNotification,
  secret?: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const request = await buildWebhookRequest(url, n, secret);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetcher(url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return true;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) {
        console.error(JSON.stringify({ message: "webhook rejected", slug: n.link.slug, status: response.status }));
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response)));
    }
  } catch (error) {
    console.error(JSON.stringify({ message: "webhook failed", slug: n.link.slug, error: String(error) }));
  }
  return false;
}
