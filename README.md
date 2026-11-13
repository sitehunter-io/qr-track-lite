# qr-track-lite

**Know the exact second a prospect scans your physical postcard or flyer.** Self-hosted on Cloudflare Workers in 60 seconds, with no bloated SaaS subscription and no tracking cookies.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sitehunter-io/qr-track-lite)

```bash
curl -X POST https://go.youragency.com/api/links -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{"slug":"austin-roofer-01","destination":"https://myagency.com","label":"Barton Creek Roofing Postcard","webhookUrl":"https://discord.com/api/webhooks/..."}'
curl -o austin-roofer-01.svg https://go.youragency.com/api/qr/austin-roofer-01.svg   # print-ready QR
```

When the business owner scans the card, they land on your page and you get this in Discord or Slack:

```
📬 Physical QR scanned!
Campaign: Barton Creek Roofing Postcard (/austin-roofer-01)
Location: Austin, TX · Device: iOS Safari · Total scans: 1
```

> **Built by the team at [SiteHunter.io](https://sitehunter.io/?utm_source=github&utm_medium=referral&utm_campaign=qr-track-lite).**
> Want to skip the printing and mailing? SiteHunter scans any US city for local businesses with broken or missing websites. Create a postcard in seconds and SiteHunter mails it to their desk, with a QR code that brings them to your site.

## What you get

- **Print-ready QR codes.** Vector SVG for the printer, PNG up to 2048 px for everything else. Proper quiet zone, your colours, selectable error correction, and a check that refuses colours too faint or inverted to scan once printed.
- **Instant scan alerts.** Discord, Slack, or any HTTPS endpoint (signed JSON). Sent after the redirect, so the person scanning never waits for them.
- **Counts you can trust.** Each link has its own Durable Object, so simultaneous scans are counted exactly. Link-preview bots (Slack, iMessage, WhatsApp, Facebook), crawlers, uptime monitors and browser prefetches are counted separately, `HEAD` requests are not counted at all, and none of them trigger an alert.
- **Hard to game.** The same phone scanning twice within a minute counts once. One network can add at most 10 scans per link per hour, and each link sends at most 30 alerts an hour, so one mischievous recipient cannot inflate your numbers or flood your channel.
- **Change the destination after printing.** The printed code keeps working; it just points somewhere new.
- **Private by design.** No cookies, and no IP addresses or raw user agents stored. See [Privacy](#privacy).
- **AI-agent friendly.** A tiny [MCP server](#use-it-from-claude-or-cursor) lets you say *"Generate a tracked QR code for my meeting with Barton Creek Roofing"* in Claude or Cursor.

## Deploy

**One click:** press the button above. Cloudflare copies the repo to your Git account, creates the KV namespace and Durable Object, and asks for `ADMIN_SECRET` (generate one with `openssl rand -hex 32`).

**From the command line:**

```bash
git clone https://github.com/sitehunter-io/qr-track-lite && cd qr-track-lite
npm install
npx wrangler deploy                      # creates the KV namespace on first deploy
npx wrangler secret put ADMIN_SECRET     # paste the output of: openssl rand -hex 32
```

### Pick your domain before you print

The domain is printed into every QR code, so choose it first. A short custom domain (`go.youragency.com`) is better than `qr-track-lite.<account>.workers.dev` for two reasons: people trust it more, and a shorter URL makes a less dense QR code that scans more reliably at small print sizes. To use one, uncomment these two lines near the top of `wrangler.toml`, put in your domain, and deploy again:

```toml
routes = [{ pattern = "go.youragency.com", custom_domain = true }]
vars = { BASE_URL = "https://go.youragency.com" }
```

Use a domain (or subdomain) of its own. The Worker answers every path on it, so destinations on that same domain are refused.

### Free plan or Paid?

The Workers Free plan is fine for trying this out and for small runs. Two things to know before you mail a real campaign:

- **Free limits are hard stops.** Each counted scan costs 1 Worker request, 1 KV read, 1 Durable Object request and 2 SQLite rows written (the scan and the running total), so the free plan's 100,000 Durable Object rows written per day works out to about 50,000 scans a day. But the plan's 100,000 Worker requests a day are shared by everything, and anyone who has one of your cards can send that many requests. Once a daily limit is used up, requests fail until 00:00 UTC, and every printed code stops working for the rest of the day.
- **Workers Paid avoids that.** On the paid plan, usage past the included amounts is billed instead of refused. Cloudflare's [Workers](https://developers.cloudflare.com/workers/platform/limits/), [KV](https://developers.cloudflare.com/kv/platform/limits/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) pages list the current limits and prices.

On either plan, with a custom domain you can also add a [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) for the short-link host in the Cloudflare dashboard (the free plan includes one) to slow down floods from a single source.

### Settings

| Name | Kind | Required | What it does |
|---|---|---|---|
| `ADMIN_SECRET` | secret | yes | Bearer token for `/api/links`. At least 16 characters. The API refuses all requests until it is set. |
| `WEBHOOK_SECRET` | secret | no | Signs generic JSON webhooks with HMAC-SHA256. |
| `DEFAULT_WEBHOOK_URL` | secret | no | Alert destination for links that have no webhook of their own. |
| `BASE_URL` | var | no | Origin used in short links and QR codes, such as `https://go.youragency.com`. Any path is ignored. Defaults to the origin the request came in on. |

## API

All `/api/links` endpoints need `Authorization: Bearer <ADMIN_SECRET>`. QR images and redirects are public. Errors look like `{"error": {"code": "slug_taken", "message": "..."}}`.

### Create a link: `POST /api/links`

```json
{
  "slug": "austin-roofer-01",
  "destination": "https://myagency.com",
  "label": "Barton Creek Roofing Postcard",
  "webhookUrl": "https://discord.com/api/webhooks/..."
}
```

Only `destination` is required. Without a `slug`, a 7-character one is generated from letters and digits that are hard to misread off a card (no `0/o`, `1/l/i`). Slugs are lowercase letters, digits and hyphens, and matching is case-insensitive. Returns `201` with the link, its `shortUrl`, the `qr.svg` and `qr.png` URLs, and the default QR code inline as `svg`. A taken slug returns `409`. If storage briefly refuses the write, you get `503 storage_busy` and nothing is created; retry.

### QR images: `GET /api/qr/<slug>.svg` and `GET /api/qr/<slug>.png`

| Query | Default | Values |
|---|---|---|
| `fg` | `000000` | Opaque hex colour for the modules, such as `1a1a2e` or `#0b3d2e`. |
| `bg` | `ffffff` | Hex colour (8-digit hex for translucency) or `transparent`. |
| `ecc` | `M` | Error correction: `L` 7%, `M` 15%, `Q` 25%, `H` 30% damage tolerance. Use `Q` or `H` for mail that gets handled roughly. |
| `margin` | `4` | Quiet zone in modules, 0–16. The QR spec asks for 4. |
| `size` | `1024` | Pixel width: 64–4096 for SVG, 64–2048 for PNG. PNGs round down to whole pixels per module so edges stay crisp. |
| `download` | | Present it to get a `Content-Disposition: attachment` response. |

The modules must be darker than the background, with at least 3:1 contrast, or the request fails with `400`. Light-on-dark codes and faint colour pairs fail to scan on many phones once printed. A translucent or transparent background is judged as if it were printed on white paper, so check the result if you print on a dark card.

### Scan: `GET /<slug>`

Responds `302` to the destination with `Cache-Control: no-store`, so every scan reaches the Worker. Tracking runs in `ctx.waitUntil()` after the response is sent. `HEAD` requests redirect without being counted.

### Stats: `GET /api/links/<slug>`

Returns the link plus:

```json
"stats": {
  "totalScans": 12,
  "automatedHits": 3,
  "filteredHits": 1,
  "firstScanAt": "2026-11-03T15:02:11.000Z",
  "lastScanAt": "2026-11-10T09:41:52.000Z",
  "recent":      [{ "at": "...", "location": "Austin, TX", "os": "iOS", "browser": "Safari", "deviceType": "mobile" }],
  "daily":       [{ "date": "2026-11-10", "scans": 4 }],
  "locations":   [{ "location": "Austin, TX", "scans": 9 }],
  "devices":     [{ "os": "iOS", "browser": "Safari", "scans": 7 }],
  "deviceTypes": [{ "deviceType": "mobile", "scans": 12 }]
}
```

- `automatedHits` are bots, link previews and prefetches.
- `filteredHits` are repeat scans from the same device within a minute, plus scans past the per-network limit.
- `recent` holds the latest 25 scans.
- `daily` always covers the last 30 UTC days, oldest first, zero-filled.
- `locations` and `devices` hold the top 10, counted over the link's full history.

### Everything else

| Request | What it does |
|---|---|
| `GET /api/links?limit=50&cursor=…` | Lists links with `totalScans` and `lastScanAt`. Up to 100 per page; pass the returned `cursor` for the next page. |
| `PATCH /api/links/<slug>` | Changes `destination`, `label` or `webhookUrl` (`null` clears the last two). The slug cannot change. |
| `DELETE /api/links/<slug>/scans` | Resets counts and history but keeps the link. Use it after you test-scan a proof. |
| `DELETE /api/links/<slug>` | Deletes the link and its history, and frees the slug. |

Changes are exact in the API immediately. The redirect itself is served from KV, which can take a minute or so to reach every Cloudflare location, so for a short while some places may still use the old destination (or, after a delete, keep redirecting).

## Webhooks

The format follows the URL:

- `https://discord.com/api/webhooks/...` gets a Discord message. Mentions and link previews are turned off, so a label can never ping `@everyone`.
- `https://hooks.slack.com/...` gets a Slack message, with link unfurling turned off.
- Anything else gets a JSON `POST`:

```json
{
  "type": "qr.scanned",
  "slug": "austin-roofer-01",
  "label": "Barton Creek Roofing Postcard",
  "shortUrl": "https://go.youragency.com/austin-roofer-01",
  "destination": "https://myagency.com/",
  "totalScans": 1,
  "suppressedAlerts": 0,
  "scannedAt": "2026-11-10T09:41:52.000Z",
  "location": { "city": "Austin", "region": "TX", "country": "US", "display": "Austin, TX" },
  "device": { "os": "iOS", "browser": "Safari", "type": "mobile", "display": "iOS Safari" }
}
```

Each link sends at most 30 alerts an hour. Scans past that are still counted. The next alert after the pause reports how many scans arrived without one, in `suppressedAlerts` (JSON) or as an extra line (Discord and Slack).

Webhooks must use HTTPS (plain `http://localhost` is allowed for local testing). A delivery is retried once on `429` or `5xx`, and failures are logged without affecting the redirect.

When `WEBHOOK_SECRET` is set, JSON webhooks carry `X-QR-Track-Timestamp` (Unix seconds) and `X-QR-Track-Signature: sha256=<hex>`, an HMAC-SHA256 of `<timestamp>.<raw body>`. To verify in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isValidSignature(rawBody, headers, secret) {
  const timestamp = String(headers["x-qr-track-timestamp"] ?? "");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300; // reject replays older than 5 minutes
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`);
  const given = Buffer.from(String(headers["x-qr-track-signature"] ?? ""));
  return fresh && given.length === expected.length && timingSafeEqual(given, expected);
}
```

## Use it from Claude or Cursor

[`examples/mcp-server.ts`](examples/mcp-server.ts) is a small MCP server with four tools:

- `create_tracked_qr` returns the links and a QR preview image, and can save the SVG or PNG to a file.
- `get_qr_stats`
- `list_tracked_qrs`
- `update_tracked_qr`

It needs Node 22.18 or later and has no build step. It only talks to `QR_TRACK_URL` over HTTPS (or plain `http://localhost`), never overwrites a file, and still returns the new link if saving the file fails.

```bash
cd examples && npm install
```

**Claude Code:**

```bash
claude mcp add qr-track \
  -e QR_TRACK_URL=https://go.youragency.com \
  -e QR_TRACK_ADMIN_SECRET=your-admin-secret \
  -- node /absolute/path/to/qr-track-lite/examples/mcp-server.ts
```

**Claude Desktop** (`claude_desktop_config.json`) or **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "qr-track": {
      "command": "node",
      "args": ["/absolute/path/to/qr-track-lite/examples/mcp-server.ts"],
      "env": {
        "QR_TRACK_URL": "https://go.youragency.com",
        "QR_TRACK_ADMIN_SECRET": "your-admin-secret"
      }
    }
  }
}
```

Then ask: *"Generate a tracked QR code for my meeting with Barton Creek Roofing that points to myagency.com/roofing, and save it to ~/Desktop/barton-creek.svg."*

## How it works

```
phone camera ──► GET /austin-roofer-01 ──► Worker ──► KV lookup ──► 302 to destination
                                              │
                                              └─ waitUntil ─► Durable Object for this slug
                                                               (filter, count +1, store scan)
                                                                    │
                                                                    └─► Discord / Slack / JSON webhook
```

- **One Durable Object per slug** is the source of truth: the link record, the running totals and the scan history, in SQLite. A Durable Object handles one request at a time, which is what makes counts exact and lets it act as the lock that stops two creates from claiming the same slug.
- **KV holds the copy that redirects read.** It is cached at the edge, so redirects stay fast. Only the link's Durable Object writes it, one change at a time, so KV always ends up matching. If KV refuses a write, the change is rolled back and the API returns `503`. If a KV read fails, the redirect asks the Durable Object instead.
- Scan counters are deliberately not kept in KV. KV has no atomic increment, and its free plan allows only 1,000 writes a day.

## Privacy

For each counted scan, qr-track-lite stores a timestamp, the city, region and country that Cloudflare derives from the connection, and the OS, browser and device type parsed from the user agent. It stores no IP addresses and no raw user agents, and it sets no cookies.

To enforce the repeat-scan and per-network limits, a link's Durable Object keeps salted hashes of recent visitors' network and device in memory for up to an hour. They are never written to storage and disappear when the object goes idle.

Nothing is sent anywhere except the webhook you configure. `wrangler.toml` turns off Cloudflare's per-request invocation logs and keeps only this Worker's own error logs. Cloudflare itself still handles every request, as any host would. `GET /robots.txt` asks crawlers to stay away from your short links.

## Known limits

- Abuse limits live in memory, so they reset when a link's Durable Object goes idle, typically after a minute or two without scans.
- If you send the short link by email instead of printing it, corporate email security scanners may open it with an ordinary browser user agent. Those opens count as scans.
- iPads set to request desktop sites identify as Macs, so they show up as `macOS` desktop scans.
- Stats are computed over the full scan history on each request. That is fast for postcard-sized campaigns; a link with hundreds of thousands of scans would want rollups.

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars     # then set ADMIN_SECRET
npm run dev                         # http://localhost:8787
npm test                            # runs inside the Workers runtime, with real KV and Durable Objects
npm run typecheck
cd examples && npm install && npm test   # drives the MCP server over stdio against a mock API
```

The tests decode every generated PNG and SVG back to its URL with [jsQR](https://github.com/cozmo/jsQR). They also inject KV failures and slow writes to check that KV and the Durable Object stay in agreement.

## License

[MIT](LICENSE)
