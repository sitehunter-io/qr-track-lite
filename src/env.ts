import type { ScanCounter } from "./counter";

export interface Env {
  /** Link records keyed by `link:<slug>`. Read on every redirect. */
  LINKS: KVNamespace;
  /** One Durable Object per slug: the authoritative link record and exact scan counts. */
  SCANS: DurableObjectNamespace<ScanCounter>;
  /** Bearer token for /api/links (16+ characters). Set with `wrangler secret put ADMIN_SECRET`. */
  ADMIN_SECRET?: string;
  /** Optional. When set, generic JSON webhooks carry an HMAC-SHA256 signature. */
  WEBHOOK_SECRET?: string;
  /** Optional. Webhook used for links that do not have one of their own. */
  DEFAULT_WEBHOOK_URL?: string;
  /** Optional. Public origin for short links, e.g. https://go.example.com. Defaults to the request origin. */
  BASE_URL?: string;
}
