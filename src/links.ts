/** Link records and input validation. */

export interface LinkRecord {
  slug: string;
  destination: string;
  label: string | null;
  webhookUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLinkInput {
  slug: string | null;
  destination: string;
  label: string | null;
  webhookUrl: string | null;
}

export interface LinkPatch {
  destination?: string;
  label?: string | null;
  webhookUrl?: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

export const KV_PREFIX = "link:";
export const kvKey = (slug: string): string => `${KV_PREFIX}${slug}`;

export const MAX_SLUG_LENGTH = 64;
export const MAX_URL_LENGTH = 2048;
export const MAX_LABEL_LENGTH = 200;

/** Lowercase letters, digits and inner hyphens. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(["api"]);

export function normalizeSlug(input: unknown): Result<string> {
  if (typeof input !== "string") return fail("slug must be a string.");
  const slug = input.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    return fail(
      `slug must be 1-${MAX_SLUG_LENGTH} characters: letters, digits and hyphens, not starting or ending with a hyphen.`,
    );
  }
  if (RESERVED_SLUGS.has(slug)) return fail(`"${slug}" is reserved.`);
  return ok(slug);
}

export function parseDestination(input: unknown): Result<string> {
  if (typeof input !== "string" || !input.trim()) return fail("destination is required.");
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) return fail(`destination must be at most ${MAX_URL_LENGTH} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("destination must be an absolute http(s) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("destination must use http or https.");
  }
  return ok(url.href);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https only; plain http is accepted for localhost so webhooks can be tested in `wrangler dev`. */
export function parseWebhookUrl(input: unknown): Result<string | null> {
  if (input === undefined || input === null || input === "") return ok(null);
  if (typeof input !== "string") return fail("webhookUrl must be a string or null.");
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) return fail(`webhookUrl must be at most ${MAX_URL_LENGTH} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("webhookUrl must be an absolute https URL.");
  }
  const isLocalHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) return fail("webhookUrl must use https.");
  return ok(url.href);
}

export function parseLabel(input: unknown): Result<string | null> {
  if (input === undefined || input === null) return ok(null);
  if (typeof input !== "string") return fail("label must be a string or null.");
  // Collapse whitespace so a label can never break the layout of a chat notification.
  const label = input.replace(/\s+/g, " ").trim();
  if (label.length > MAX_LABEL_LENGTH) return fail(`label must be at most ${MAX_LABEL_LENGTH} characters.`);
  return ok(label || null);
}

function asObject(body: unknown): Result<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Request body must be a JSON object.");
  }
  return ok(body as Record<string, unknown>);
}

const CREATE_FIELDS = new Set(["slug", "destination", "label", "webhookUrl"]);
const PATCH_FIELDS = new Set(["destination", "label", "webhookUrl"]);

function unknownField(obj: Record<string, unknown>, allowed: Set<string>): string | null {
  return Object.keys(obj).find((key) => !allowed.has(key)) ?? null;
}

export function parseCreateInput(body: unknown): Result<CreateLinkInput> {
  const obj = asObject(body);
  if (!obj.ok) return obj;
  const extra = unknownField(obj.value, CREATE_FIELDS);
  if (extra) return fail(`Unknown field "${extra}". Allowed: slug, destination, label, webhookUrl.`);

  const { slug: rawSlug, destination: rawDestination, label: rawLabel, webhookUrl: rawWebhook } = obj.value;
  let slug: string | null = null;
  if (rawSlug !== undefined && rawSlug !== null && rawSlug !== "") {
    const parsed = normalizeSlug(rawSlug);
    if (!parsed.ok) return parsed;
    slug = parsed.value;
  }
  const destination = parseDestination(rawDestination);
  if (!destination.ok) return destination;
  const label = parseLabel(rawLabel);
  if (!label.ok) return label;
  const webhookUrl = parseWebhookUrl(rawWebhook);
  if (!webhookUrl.ok) return webhookUrl;

  return ok({ slug, destination: destination.value, label: label.value, webhookUrl: webhookUrl.value });
}

export function parsePatchInput(body: unknown): Result<LinkPatch> {
  const obj = asObject(body);
  if (!obj.ok) return obj;
  const extra = unknownField(obj.value, PATCH_FIELDS);
  if (extra) {
    const hint = extra === "slug" ? " A slug cannot be changed; create a new link instead." : "";
    return fail(`Unknown field "${extra}". Allowed: destination, label, webhookUrl.${hint}`);
  }

  const patch: LinkPatch = {};
  if ("destination" in obj.value) {
    const destination = parseDestination(obj.value.destination);
    if (!destination.ok) return destination;
    patch.destination = destination.value;
  }
  if ("label" in obj.value) {
    const label = parseLabel(obj.value.label);
    if (!label.ok) return label;
    patch.label = label.value;
  }
  if ("webhookUrl" in obj.value) {
    const webhookUrl = parseWebhookUrl(obj.value.webhookUrl);
    if (!webhookUrl.ok) return webhookUrl;
    patch.webhookUrl = webhookUrl.value;
  }
  if (Object.keys(patch).length === 0) return fail("Nothing to update. Send destination, label or webhookUrl.");
  return ok(patch);
}

/** No 0/o, 1/l/i, so a slug read off a printed card can be typed back without guessing. */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateSlug(length = 7): string {
  const limit = 256 - (256 % SLUG_ALPHABET.length); // rejection sampling keeps every character equally likely
  let slug = "";
  while (slug.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && slug.length < length) slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
    }
  }
  return slug;
}
