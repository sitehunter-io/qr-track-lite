/**
 * Drives mcp-server.ts over stdio, the way Claude or Cursor would, against a mock
 * qr-track-lite API. Run with: npm test (inside examples/).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("./mcp-server.ts", import.meta.url));
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

type Content = Array<{ type: string; text?: string; data?: string }>;

const requested: string[] = [];
let base = "";

function handle(req: IncomingMessage, res: ServerResponse) {
  requested.push(`${req.method} ${req.url}`);
  const url = new URL(req.url ?? "/", base);
  const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  if (req.method === "POST" && url.pathname === "/api/links") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { slug?: string; destination: string; label?: string };
      if (body.slug === "taken") return json(409, { error: { code: "slug_taken", message: 'The slug "taken" is already in use.' } });
      const slug = body.slug ?? "gen1234";
      json(201, {
        slug,
        shortUrl: `${base}/${slug}`,
        destination: body.destination,
        label: body.label ?? null,
        webhookKind: null,
        // A hostile or compromised API could point these anywhere; the client must ignore them.
        qr: { svg: `${base}/secret`, png: `${base}/secret` },
        svg: "<svg><script>alert(1)</script></svg>",
      });
    });
    return;
  }
  const qr = /^\/api\/qr\/([a-z0-9-]+)\.(svg|png)$/.exec(url.pathname);
  if (qr) {
    if (qr[1] === "broken-preview") return json(404, { error: { message: "nope" } });
    if (qr[2] === "svg") return res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" }).end(SVG);
    return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  }
  json(404, { error: { message: "not found" } });
}

const mock = createServer(handle);
let client: Client;
let home: string;

before(async () => {
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "qr-mcp-home-"));
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...(process.env as Record<string, string>), HOME: home, QR_TRACK_URL: base, QR_TRACK_ADMIN_SECRET: "test-secret-0123456789" },
    }),
  );
});

after(async () => {
  await client.close();
  mock.close();
});

async function create(args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "create_tracked_qr", arguments: { destination: "https://example.com", ...args } })) as {
    isError?: boolean;
    content: Content;
  };
  return { ...result, text: result.content.find((c) => c.type === "text")?.text ?? "" };
}

describe("create_tracked_qr", () => {
  it("expands ~ and saves the image fetched from QR_TRACK_URL, not from the API response", async () => {
    const result = await create({ slug: "home-save", saveTo: "~/postcard.svg" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Saved: .*postcard\.svg/);
    assert.equal(await readFile(join(home, "postcard.svg"), "utf8"), SVG);
    assert.ok(result.content.some((c) => c.type === "image"));
    assert.ok(!requested.some((line) => line.includes("/secret")), "followed a URL from the API response");
  });

  it("still returns the link when saving fails", async () => {
    const result = await create({ slug: "bad-dir", saveTo: join(home, "missing-dir", "qr.png") });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Short link: .*\/bad-dir/);
    assert.match(result.text, /Not saved/);
  });

  it("never overwrites an existing file", async () => {
    const path = join(home, "keep.svg");
    await writeFile(path, "original");
    const result = await create({ slug: "no-clobber", saveTo: path });
    assert.match(result.text, /already exists/);
    assert.equal(await readFile(path, "utf8"), "original");
  });

  it("refuses relative paths, whose meaning depends on the client's working directory", async () => {
    const result = await create({ slug: "relative", saveTo: "qr.svg" });
    assert.match(result.text, /Not saved \(use an absolute path/);
  });

  it("drops a preview that is not a PNG instead of failing", async () => {
    const result = await create({ slug: "broken-preview" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Preview unavailable/);
    assert.ok(!result.content.some((c) => c.type === "image"));
  });

  it("reports API errors as tool errors", async () => {
    const result = await create({ slug: "taken" });
    assert.equal(result.isError, true);
    assert.match(result.text, /already in use/);
  });
});

describe("startup", () => {
  it("refuses to send the admin secret over plain http to a remote host", () => {
    const run = spawnSync(process.execPath, [SERVER], {
      env: { ...process.env, QR_TRACK_URL: "http://example.com", QR_TRACK_ADMIN_SECRET: "x".repeat(20) },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /must use https/);
  });
});
