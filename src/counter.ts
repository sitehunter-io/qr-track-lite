import { DurableObject } from "cloudflare:workers";
import { formatLocation, networkKey, type DeviceType, type ScanEvent } from "./analytics";
import type { Env } from "./env";
import { kvKey, type LinkPatch, type LinkRecord } from "./links";

export interface ScanTotals {
  totalScans: number;
  /** Bots, link previews and prefetches: redirected, never counted. */
  automatedHits: number;
  /** Repeat scans from the same device within a minute, or past the per-network limit: redirected, never counted. */
  filteredHits: number;
  firstScanAt: string | null;
  lastScanAt: string | null;
}

export interface RecentScan {
  at: string;
  location: string;
  city: string | null;
  region: string | null;
  country: string | null;
  os: string;
  browser: string;
  deviceType: DeviceType;
}

export interface LinkStats extends ScanTotals {
  /** Newest first, up to 25. */
  recent: RecentScan[];
  /** One entry per UTC day for the last 30 days, oldest first, zero-filled. */
  daily: Array<{ date: string; scans: number }>;
  locations: Array<{ location: string; city: string | null; region: string | null; country: string | null; scans: number }>;
  devices: Array<{ os: string; browser: string; scans: number }>;
  deviceTypes: Array<{ deviceType: DeviceType; scans: number }>;
}

/** Who sent a scan, for abuse limits only. Held in memory as salted hashes, never stored. */
export interface ScanClient {
  ip: string | null;
  userAgent: string;
}

export type RecordScanResult =
  | { status: "missing" | "automated" | "filtered" }
  | {
      status: "counted";
      totalScans: number;
      link: LinkRecord;
      /** null when this link is over its alert limit; otherwise how many alerts were held back before this one. */
      alert: { suppressed: number } | null;
    };

/** "unavailable" means KV refused the write (for example its 1-write-per-second-per-key limit); nothing changed. */
export type WriteResult<T> = T | { status: "unavailable" };

// Abuse limits. In memory only, so they reset if the object is evicted after a quiet spell.
export const REPEAT_WINDOW_MS = 60_000; // the same device scanning again within a minute is one scan
export const NETWORK_WINDOW_MS = 3_600_000;
export const NETWORK_MAX_SCANS = 10; // counted scans per network (IPv4 address or IPv6 /64), per link, per hour
export const ALERT_WINDOW_MS = 3_600_000;
export const ALERT_MAX = 30; // webhook alerts per link per hour
const FLUSH_INTERVAL_MS = 10_000; // uncounted hits are written to storage at most this often
const MAX_TRACKED_CLIENTS = 10_000;

const SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

type TotalsRow = {
  scans: number;
  automated: number;
  filtered: number;
  first_scan_at: number | null;
  last_scan_at: number | null;
};

type ScanRow = {
  ts: number;
  city: string | null;
  region: string | null;
  country: string | null;
  os: string;
  browser: string;
  device_type: string;
};

/** A fast synchronous 53-bit string hash (cyrb53). Salted per instance, so keys are not comparable across objects. */
function hash53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * One instance per slug. It is the source of truth for the link and its scans,
 * and the only writer of the link's KV copy. Link changes run inside
 * blockConcurrencyWhile, so KV receives them in exactly the order they were
 * committed here. recordScan never awaits, so every scan decision is atomic.
 *
 * Cost per counted scan: 1 Durable Object request and 2 SQLite rows written
 * (the scan row and the running total).
 */
export class ScanCounter extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private schemaReady = false;

  // In-memory abuse state. Never persisted.
  private readonly salt = crypto.getRandomValues(new Uint32Array(1))[0]!;
  private lastSeenByDevice = new Map<number, number>();
  private networkWindows = new Map<number, { start: number; count: number }>();
  private alertWindow = { start: 0, count: 0, suppressed: 0 };
  private pending = { automated: 0, filtered: 0 };
  private lastFlush = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const version =
      this.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0]?.value ?? 0;
    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS link (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          record TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS totals (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          scans INTEGER NOT NULL DEFAULT 0,
          automated INTEGER NOT NULL DEFAULT 0,
          filtered INTEGER NOT NULL DEFAULT 0,
          first_scan_at INTEGER,
          last_scan_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS scans (
          id INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          city TEXT,
          region TEXT,
          country TEXT,
          os TEXT NOT NULL,
          browser TEXT NOT NULL,
          device_type TEXT NOT NULL
        );
      `);
    }
    // Future migrations go here: if (version < 2) { ALTER TABLE ... }
    if (version < SCHEMA_VERSION) {
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        SCHEMA_VERSION,
      );
    }
    this.schemaReady = true;
  }

  private readLink(): LinkRecord | null {
    const row = this.sql.exec<{ record: string }>("SELECT record FROM link WHERE id = 1").toArray()[0];
    return row ? (JSON.parse(row.record) as LinkRecord) : null;
  }

  private readTotals(): ScanTotals {
    const row = this.sql
      .exec<TotalsRow>("SELECT scans, automated, filtered, first_scan_at, last_scan_at FROM totals WHERE id = 1")
      .toArray()[0];
    return {
      totalScans: row?.scans ?? 0,
      automatedHits: (row?.automated ?? 0) + this.pending.automated,
      filteredHits: (row?.filtered ?? 0) + this.pending.filtered,
      firstScanAt: iso(row?.first_scan_at ?? null),
      lastScanAt: iso(row?.last_scan_at ?? null),
    };
  }

  private resetMemory(): void {
    this.lastSeenByDevice.clear();
    this.networkWindows.clear();
    this.alertWindow = { start: 0, count: 0, suppressed: 0 };
    this.pending = { automated: 0, filtered: 0 };
    this.lastFlush = 0;
  }

  // --- Link lifecycle (each change is mirrored to KV, in commit order) --------

  /** Claims the slug and publishes it to KV. "taken" if the slug already exists. */
  create(record: LinkRecord): Promise<WriteResult<{ status: "created" | "taken" }>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      if (this.readLink()) return { status: "taken" as const };
      this.sql.exec("INSERT INTO link (id, record) VALUES (1, ?)", JSON.stringify(record));
      try {
        await this.env.LINKS.put(kvKey(record.slug), JSON.stringify(record));
      } catch (error) {
        this.sql.exec("DELETE FROM link");
        console.error(JSON.stringify({ message: "KV write failed on create", slug: record.slug, error: String(error) }));
        return { status: "unavailable" as const };
      }
      return { status: "created" as const };
    });
  }

  getLink(): LinkRecord | null {
    this.ensureSchema();
    return this.readLink();
  }

  update(patch: LinkPatch, updatedAt: string): Promise<WriteResult<{ status: "missing" } | { status: "updated"; link: LinkRecord }>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      const current = this.readLink();
      if (!current) return { status: "missing" as const };
      const next: LinkRecord = { ...current, ...patch, slug: current.slug, createdAt: current.createdAt, updatedAt };
      this.sql.exec("UPDATE link SET record = ? WHERE id = 1", JSON.stringify(next));
      try {
        await this.env.LINKS.put(kvKey(current.slug), JSON.stringify(next));
      } catch (error) {
        this.sql.exec("UPDATE link SET record = ? WHERE id = 1", JSON.stringify(current));
        // If the failed write did land (a timeout after the fact), put the old record back so KV matches.
        await this.env.LINKS.put(kvKey(current.slug), JSON.stringify(current)).catch(() => {});
        console.error(JSON.stringify({ message: "KV write failed on update", slug: current.slug, error: String(error) }));
        return { status: "unavailable" as const };
      }
      return { status: "updated" as const, link: next };
    });
  }

  /** Unpublishes the link from KV, then deletes it and its history. Also cleans up a stray KV copy. */
  destroy(slug: string): Promise<WriteResult<{ status: "deleted" | "missing" }>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.env.LINKS.delete(kvKey(slug));
      } catch (error) {
        console.error(JSON.stringify({ message: "KV delete failed", slug, error: String(error) }));
        return { status: "unavailable" as const };
      }
      this.ensureSchema();
      const existed = this.readLink() !== null;
      await this.ctx.storage.deleteAll();
      this.schemaReady = false;
      this.resetMemory();
      return { status: existed ? ("deleted" as const) : ("missing" as const) };
    });
  }

  // --- Scans --------------------------------------------------------------------

  /** Writes uncounted hits at most every FLUSH_INTERVAL_MS, so a flood cannot burn the daily row-write quota. */
  private flushPending(now: number, force = false): void {
    const { automated, filtered } = this.pending;
    if (automated + filtered === 0 || (!force && now - this.lastFlush < FLUSH_INTERVAL_MS)) return;
    this.sql.exec(
      `INSERT INTO totals (id, automated, filtered) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET automated = automated + ?1, filtered = filtered + ?2`,
      automated,
      filtered,
    );
    this.pending = { automated: 0, filtered: 0 };
    this.lastFlush = now;
  }

  private pruneClients(now: number): void {
    if (this.lastSeenByDevice.size + this.networkWindows.size < MAX_TRACKED_CLIENTS) return;
    for (const [key, seen] of this.lastSeenByDevice) if (now - seen >= REPEAT_WINDOW_MS) this.lastSeenByDevice.delete(key);
    for (const [key, win] of this.networkWindows) if (now - win.start >= NETWORK_WINDOW_MS) this.networkWindows.delete(key);
    // Still full (a flood from many networks): forget the oldest half rather than grow without bound.
    if (this.lastSeenByDevice.size > MAX_TRACKED_CLIENTS / 2) {
      this.lastSeenByDevice = new Map([...this.lastSeenByDevice].slice(-MAX_TRACKED_CLIENTS / 4));
    }
    if (this.networkWindows.size > MAX_TRACKED_CLIENTS / 2) {
      this.networkWindows = new Map([...this.networkWindows].slice(-MAX_TRACKED_CLIENTS / 4));
    }
  }

  /** Synchronous on purpose: no await, so no other request can interleave with a decision. */
  recordScan(event: ScanEvent, automated: boolean, client: ScanClient): RecordScanResult {
    this.ensureSchema();
    const link = this.readLink();
    if (!link) return { status: "missing" }; // deleted, but an edge cache still had it
    const now = event.ts;

    if (automated) {
      this.pending.automated++;
      this.flushPending(now);
      return { status: "automated" };
    }

    this.pruneClients(now);
    const network = hash53(networkKey(client.ip), this.salt);
    const device = hash53(`${networkKey(client.ip)}|${client.userAgent}`, this.salt);

    const seen = this.lastSeenByDevice.get(device);
    this.lastSeenByDevice.set(device, now);
    let window = this.networkWindows.get(network);
    if (!window || now - window.start >= NETWORK_WINDOW_MS) window = { start: now, count: 0 };
    this.networkWindows.set(network, window);

    if ((seen !== undefined && now - seen < REPEAT_WINDOW_MS) || window.count >= NETWORK_MAX_SCANS) {
      this.pending.filtered++;
      this.flushPending(now);
      return { status: "filtered" };
    }
    window.count++;

    this.sql.exec(
      "INSERT INTO scans (ts, city, region, country, os, browser, device_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      event.ts,
      event.city,
      event.region,
      event.country,
      event.os,
      event.browser,
      event.deviceType,
    );
    // The running total also absorbs any uncounted hits waiting to be written, at no extra row cost.
    const { scans } = this.sql
      .exec<{ scans: number }>(
        `INSERT INTO totals (id, scans, automated, filtered, first_scan_at, last_scan_at) VALUES (1, 1, ?2, ?3, ?1, ?1)
         ON CONFLICT (id) DO UPDATE SET
           scans = scans + 1,
           automated = automated + ?2,
           filtered = filtered + ?3,
           first_scan_at = COALESCE(first_scan_at, ?1),
           last_scan_at = ?1
         RETURNING scans`,
        now,
        this.pending.automated,
        this.pending.filtered,
      )
      .one();
    this.pending = { automated: 0, filtered: 0 };
    this.lastFlush = now;

    let alert: { suppressed: number } | null = null;
    if (now - this.alertWindow.start >= ALERT_WINDOW_MS) this.alertWindow = { ...this.alertWindow, start: now, count: 0 };
    if (this.alertWindow.count < ALERT_MAX) {
      this.alertWindow.count++;
      alert = { suppressed: this.alertWindow.suppressed };
      this.alertWindow.suppressed = 0;
    } else {
      this.alertWindow.suppressed++;
    }
    return { status: "counted", totalScans: scans, link, alert };
  }

  // --- Reads ------------------------------------------------------------------

  getSummary(): { link: LinkRecord; totals: ScanTotals } | null {
    this.ensureSchema();
    const link = this.readLink();
    return link ? { link, totals: this.readTotals() } : null;
  }

  getStats(now: number = Date.now()): { link: LinkRecord; stats: LinkStats } | null {
    this.ensureSchema();
    const link = this.readLink();
    if (!link) return null;

    const recent = this.sql
      .exec<ScanRow>(
        "SELECT ts, city, region, country, os, browser, device_type FROM scans ORDER BY id DESC LIMIT 25",
      )
      .toArray()
      .map((row) => ({
        at: new Date(row.ts).toISOString(),
        location: formatLocation(row),
        city: row.city,
        region: row.region,
        country: row.country,
        os: row.os,
        browser: row.browser,
        deviceType: row.device_type as DeviceType,
      }));

    const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
    const windowStart = todayStart - 29 * DAY_MS;
    const perDay = new Map(
      this.sql
        .exec<{ day: string; scans: number }>(
          `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, COUNT(*) AS scans
           FROM scans WHERE ts >= ? GROUP BY day`,
          windowStart,
        )
        .toArray()
        .map((row) => [row.day, row.scans] as const),
    );
    const daily = Array.from({ length: 30 }, (_, i) => {
      const date = new Date(windowStart + i * DAY_MS).toISOString().slice(0, 10);
      return { date, scans: perDay.get(date) ?? 0 };
    });

    const locations = this.sql
      .exec<{ city: string | null; region: string | null; country: string | null; scans: number }>(
        `SELECT city, region, country, COUNT(*) AS scans FROM scans
         GROUP BY city, region, country ORDER BY scans DESC, MAX(ts) DESC LIMIT 10`,
      )
      .toArray()
      .map((row) => ({ location: formatLocation(row), ...row }));

    const devices = this.sql
      .exec<{ os: string; browser: string; scans: number }>(
        `SELECT os, browser, COUNT(*) AS scans FROM scans
         GROUP BY os, browser ORDER BY scans DESC, MAX(ts) DESC LIMIT 10`,
      )
      .toArray();

    const deviceTypes = this.sql
      .exec<{ device_type: string; scans: number }>(
        "SELECT device_type, COUNT(*) AS scans FROM scans GROUP BY device_type ORDER BY scans DESC",
      )
      .toArray()
      .map((row) => ({ deviceType: row.device_type as DeviceType, scans: row.scans }));

    return { link, stats: { ...this.readTotals(), recent, daily, locations, devices, deviceTypes } };
  }

  /** Clears scan history, counters and abuse windows, keeping the link. Use it after test-scanning a proof. */
  resetScans(): boolean {
    this.ensureSchema();
    if (!this.readLink()) return false;
    this.sql.exec("DELETE FROM scans");
    this.sql.exec("DELETE FROM totals");
    this.resetMemory();
    return true;
  }
}
