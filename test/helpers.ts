import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import jsQR from "jsqr";
import type { Env } from "../src/env";
import worker from "../src/index";

export const ADMIN_SECRET = "test-admin-secret-0123456789";
export const ORIGIN = "https://qr.example.com";
export const testEnv = env as unknown as Env;

export const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
export const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
export const AUSTIN = { city: "Austin", region: "Texas", regionCode: "TX", country: "US" };

interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean | string;
  cf?: Record<string, unknown>;
  env?: Partial<Env>;
}

/** Calls the Worker and waits for its waitUntil() work (scan tracking, webhooks) to settle. */
export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.auth !== false) {
    headers.set("authorization", `Bearer ${typeof options.auth === "string" ? options.auth : ADMIN_SECRET}`);
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const request = new Request(`${ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
    redirect: "manual",
    cf: options.cf,
  } as RequestInit);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...testEnv, ...options.env }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

let ipCounter = 0;
/** A distinct IPv4 address per call, so separate test scans look like separate people. */
export const nextIp = () => `198.51.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

/** A person scanning the code with a phone: no auth header, a phone user agent, Cloudflare geo. */
export function scan(
  slug: string,
  userAgent = IPHONE_SAFARI,
  cf: Record<string, unknown> = AUSTIN,
  extraHeaders: Record<string, string> = {},
  env?: Partial<Env>,
) {
  return call(`/${slug}`, {
    auth: false,
    headers: { "user-agent": userAgent, "cf-connecting-ip": nextIp(), ...extraHeaders },
    cf,
    env,
  });
}

let counter = 0;
export const uniqueSlug = (prefix = "t") => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export async function createLink(input: Record<string, unknown> = {}) {
  const response = await call("/api/links", {
    method: "POST",
    body: { slug: uniqueSlug(), destination: "https://example.com/landing", ...input },
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { slug: string; shortUrl: string; svg: string; qr: { svg: string; png: string } };
}

/** Minimal decoder for the PNGs this project writes (1-bit indexed, filter 0), composited onto white. */
export async function decodePng(png: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => png[i] === byte)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let palette: Uint8Array = new Uint8Array(0);
  let alpha: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (data[8] !== 1 || data[9] !== 3) throw new Error("expected 1-bit indexed PNG");
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") alpha = data;
    else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = Math.ceil(width / 8) + 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error("unexpected filter type");
    for (let x = 0; x < width; x++) {
      const index = (raw[y * stride + 1 + (x >> 3)]! >> (7 - (x & 7))) & 1;
      const a = (alpha[index] ?? 255) / 255;
      for (let c = 0; c < 3; c++) {
        rgba[(y * width + x) * 4 + c] = Math.round(palette[index * 3 + c]! * a + 255 * (1 - a));
      }
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export async function readQr(png: Uint8Array): Promise<string | null> {
  const { width, height, rgba } = await decodePng(png);
  return jsQR(rgba, width, height)?.data ?? null;
}
