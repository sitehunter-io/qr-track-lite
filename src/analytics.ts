/**
 * Turns a scan request into a privacy-light event: coarse location from
 * Cloudflare's edge, plus OS, browser and device type parsed from the user agent.
 * No IP address, raw user agent or cookie is stored.
 */

export type DeviceType = "mobile" | "tablet" | "desktop" | "unknown";

export interface ScanEvent {
  /** Unix epoch milliseconds. */
  ts: number;
  city: string | null;
  /** State or province code in the US and Canada (TX, ON), region name elsewhere (England). */
  region: string | null;
  /** ISO 3166-1 alpha-2 country code. */
  country: string | null;
  os: string;
  browser: string;
  deviceType: DeviceType;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 100) : null;
}

export function describeScan(request: Request, now: number = Date.now()): ScanEvent {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  let country = clean(cf?.country);
  if (country === "XX") country = null; // Cloudflare's "unknown"
  const regionCode = clean(cf?.regionCode);
  const regionName = clean(cf?.region);
  const region = country === "US" || country === "CA" ? (regionCode ?? regionName) : (regionName ?? regionCode);
  const ua = parseUserAgent(request.headers.get("user-agent") ?? "");
  return { ts: now, city: clean(cf?.city), region, country, ...ua };
}

export interface ParsedUserAgent {
  os: string;
  browser: string;
  deviceType: DeviceType;
}

// Order matters: in-app browsers and Chromium forks also carry "Chrome" or "Safari".
const BROWSERS: Array<[RegExp, string]> = [
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB/, "Facebook"],
  [/LinkedInApp/i, "LinkedIn"],
  [/\bGSA\//, "Google app"],
  [/EdgiOS|EdgA|Edg\//, "Edge"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/OPiOS|OPR\/|Opera/, "Opera"],
  [/DuckDuckGo/i, "DuckDuckGo"],
  [/FxiOS|Firefox\//, "Firefox"],
  [/CriOS|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

export function parseUserAgent(ua: string): ParsedUserAgent {
  if (!ua) return { os: "Unknown", browser: "Unknown", deviceType: "unknown" };

  let os = "Other";
  let deviceType: DeviceType = "desktop";
  if (/iPhone|iPod/.test(ua)) {
    os = "iOS";
    deviceType = "mobile";
  } else if (/iPad/.test(ua)) {
    os = "iPadOS";
    deviceType = "tablet";
  } else if (/Android/.test(ua)) {
    os = "Android";
    deviceType = /Mobile/.test(ua) ? "mobile" : "tablet";
  } else if (/Windows/.test(ua)) {
    os = "Windows";
  } else if (/CrOS/.test(ua)) {
    os = "ChromeOS";
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    os = "macOS";
  } else if (/Linux/.test(ua)) {
    os = "Linux";
  } else {
    deviceType = "unknown";
  }

  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? "Other";
  return { os, browser, deviceType };
}

// Link-preview fetchers, crawlers, uptime monitors and HTTP libraries. Patterns are
// narrow on purpose: in-app browsers (Pinterest, Telegram, Instagram, Facebook) open
// real scans and must not match. "cubot" is a phone brand, not a bot.
const AUTOMATED_UA =
  /(?:bot|crawler|spider)\b|slurp|facebookexternalhit|facebot|embedly|preview|whatsapp\/|skypeuripreview|vkshare|pinterest\/0\.|quora link|outbrain|mastodon\/|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|dalvik\/|cfnetwork\/|java\/|libwww|httpclient|axios|node-fetch|undici|postman|insomnia|scrapy|gptbot|claude-web|perplexity|bytespider|petalbot|ahrefs|semrush/i;

/**
 * True when the request is almost certainly not a person scanning the code:
 * no user agent, a known bot or link-preview fetcher, or a browser prefetch.
 * These hits still redirect but are counted separately and never notify.
 */
export function isAutomated(request: Request): boolean {
  const ua = request.headers.get("user-agent")?.trim() ?? "";
  if (!ua) return true;
  if (AUTOMATED_UA.test(ua.replace(/cubot/gi, ""))) return true;
  const purpose = [
    request.headers.get("sec-purpose"),
    request.headers.get("purpose"),
    request.headers.get("x-purpose"),
    request.headers.get("x-moz"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /prefetch|prerender|preview/.test(purpose);
}

/**
 * The network a scan came from, for per-network abuse limits: the full IPv4
 * address, or the /64 prefix for IPv6 (one household or phone usually owns a
 * whole /64, so rotating addresses inside it does not dodge the limit).
 */
export function networkKey(ip: string | null): string {
  if (!ip) return "unknown";
  const address = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** "Austin, TX" in the US; "Toronto, ON, CA" or "London, England, GB" elsewhere. */
export function formatLocation(scan: Pick<ScanEvent, "city" | "region" | "country">): string {
  const parts = [scan.city, scan.region].filter((part): part is string => Boolean(part));
  if (scan.country && scan.country !== "US") parts.push(scan.country);
  if (parts.length === 0 && scan.country === "US") parts.push("US");
  return parts.length ? parts.join(", ") : "Unknown location";
}

/** "iOS Safari", "Android Chrome". */
export function formatDevice(scan: Pick<ScanEvent, "os" | "browser">): string {
  if (scan.os === "Unknown" && scan.browser === "Unknown") return "Unknown device";
  return `${scan.os} ${scan.browser}`;
}
