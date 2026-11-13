/**
 * Print-ready QR codes. SVG is the format to send to a printer (vector, any
 * size); PNG is for tools that only take images. Both come from the same
 * module matrix with a proper quiet zone, and the PNG encoder is built in, so
 * there is no image dependency.
 */
import { encode } from "uqr";
import type { Result } from "./links";

export type Ecc = "L" | "M" | "Q" | "H";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0 (transparent) to 255 (opaque). */
  a: number;
}

export interface QrStyle {
  /** Error correction. M (15% damage tolerance) is the default; Q or H survive scuffed mail better. */
  ecc: Ecc;
  /** Quiet zone in modules. The QR spec asks for 4. */
  margin: number;
  foreground: Rgba;
  background: Rgba;
  /** Pixel width and height. For PNG it is rounded down to whole pixels per module. */
  size: number;
}

export const DEFAULT_QR_STYLE: QrStyle = {
  ecc: "M",
  margin: 4,
  foreground: { r: 0, g: 0, b: 0, a: 255 },
  background: { r: 255, g: 255, b: 255, a: 255 },
  size: 1024,
};

export const MIN_SIZE = 64;
/** SVG size is only its display width. PNG is capped lower to stay well inside the Free plan's 10 ms CPU limit. */
export const MAX_SIZE = { svg: 4096, png: 2048 } as const;
export const MAX_MARGIN = 16;
/** Below this foreground/background contrast, many phone cameras fail to read a printed code. */
export const MIN_CONTRAST = 3;

export function parseColor(input: string): Rgba | null {
  const value = input.trim().replace(/^#/, "").toLowerCase();
  if (value === "transparent") return { r: 255, g: 255, b: 255, a: 0 };
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value)) return null;
  const hex = value.length <= 4 ? [...value].map((ch) => ch + ch).join("") : value;
  const channel = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { r: channel(0), g: channel(1), b: channel(2), a: hex.length === 8 ? channel(3) : 255 };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** What a (possibly translucent) background looks like printed on white paper. */
function onPaper(c: Rgba): Rgba {
  const alpha = c.a / 255;
  const mix = (v: number) => Math.round(v * alpha + 255 * (1 - alpha));
  return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: 255 };
}

/** Contrast of an opaque foreground against the background as printed on white paper. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const [hi, lo] = [luminance(foreground), luminance(onPaper(background))].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function parseIntParam(raw: string | null, name: string, min: number, max: number): Result<number | null> {
  if (raw === null || raw === "") return { ok: true, value: null };
  if (!/^\d+$/.test(raw)) return { ok: false, error: `${name} must be a whole number.` };
  const value = Number(raw);
  if (value < min || value > max) return { ok: false, error: `${name} must be between ${min} and ${max}.` };
  return { ok: true, value };
}

/** Reads `fg`, `bg`, `ecc`, `margin` and `size` from a query string. */
export function parseQrStyle(params: URLSearchParams, format: "svg" | "png" = "svg"): Result<QrStyle> {
  const style: QrStyle = { ...DEFAULT_QR_STYLE };

  const fg = params.get("fg");
  if (fg) {
    const color = parseColor(fg);
    // An opaque foreground keeps SVG and PNG identical and makes the contrast check exact.
    if (!color || color.a !== 255) return { ok: false, error: "fg must be an opaque hex colour such as 000000 or 1a1a2e." };
    style.foreground = color;
  }
  const bg = params.get("bg");
  if (bg) {
    const color = parseColor(bg);
    if (!color) return { ok: false, error: 'bg must be a hex colour such as ffffff, or "transparent".' };
    style.background = color;
  }
  const ecc = params.get("ecc");
  if (ecc) {
    const level = ecc.toUpperCase();
    if (level !== "L" && level !== "M" && level !== "Q" && level !== "H") {
      return { ok: false, error: "ecc must be L, M, Q or H." };
    }
    style.ecc = level;
  }
  const margin = parseIntParam(params.get("margin"), "margin", 0, MAX_MARGIN);
  if (!margin.ok) return margin;
  if (margin.value !== null) style.margin = margin.value;
  const size = parseIntParam(params.get("size"), "size", MIN_SIZE, MAX_SIZE[format]);
  if (!size.ok) return size;
  if (size.value !== null) style.size = size.value;

  // Many phone cameras cannot read light modules on a dark background.
  if (luminance(style.foreground) > luminance(onPaper(style.background))) {
    return { ok: false, error: "fg must be darker than bg. Inverted (light on dark) codes do not scan on many phones." };
  }
  const contrast = contrastRatio(style.foreground, style.background);
  if (contrast < MIN_CONTRAST) {
    return {
      ok: false,
      error: `fg and bg contrast is ${contrast.toFixed(2)}:1; printed codes need at least ${MIN_CONTRAST}:1 to scan reliably. Use a darker fg or lighter bg.`,
    };
  }
  return { ok: true, value: style };
}

/** The QR module matrix without a border: `true` is a dark module. */
export function qrModules(text: string, ecc: Ecc): boolean[][] {
  return encode(text, { ecc, border: 0 }).data;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

function svgFill(color: Rgba): string {
  const fill = `fill="#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}"`;
  return color.a < 255 ? `${fill} fill-opacity="${(color.a / 255).toFixed(3)}"` : fill;
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderSvg(text: string, style: QrStyle = DEFAULT_QR_STYLE): string {
  const modules = qrModules(text, style.ecc);
  const count = modules.length;
  const total = count + style.margin * 2;

  // One path; each horizontal run of dark modules is a single rectangle.
  let path = "";
  for (let y = 0; y < count; y++) {
    const row = modules[y]!;
    for (let x = 0; x < count; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < count && row[x + run]) run++;
      path += `M${x + style.margin} ${y + style.margin}h${run}v1h-${run}z`;
      x += run;
    }
  }

  const background =
    style.background.a > 0 ? `<rect width="${total}" height="${total}" ${svgFill(style.background)}/>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${style.size}" height="${style.size}" shape-rendering="crispEdges" role="img">` +
    `<title>QR code for ${escapeXml(text)}</title>` +
    background +
    `<path ${svgFill(style.foreground)} d="${path}"/>` +
    `</svg>`
  );
}

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib-wrapped DEFLATE, which is what PNG's IDAT chunk expects. */
async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A 1-bit indexed PNG: palette entry 0 is the background, 1 the foreground. */
export async function renderPng(text: string, style: QrStyle = DEFAULT_QR_STYLE): Promise<Uint8Array> {
  const modules = qrModules(text, style.ecc);
  const count = modules.length;
  const total = count + style.margin * 2;
  const scale = Math.max(1, Math.floor(style.size / total));
  const width = total * scale;
  const rowBytes = Math.ceil(width / 8);
  const stride = rowBytes + 1; // leading filter byte (0 = none) on every scanline
  const raw = new Uint8Array(stride * width);

  for (let my = 0; my < total; my++) {
    const line = new Uint8Array(rowBytes);
    const row = modules[my - style.margin];
    if (row) {
      for (let mx = 0; mx < count; mx++) {
        if (!row[mx]) continue;
        const start = (mx + style.margin) * scale;
        for (let px = start; px < start + scale; px++) line[px >> 3]! |= 0x80 >> (px & 7);
      }
    }
    for (let r = 0; r < scale; r++) raw.set(line, (my * scale + r) * stride + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, width);
  header.set([1, 3, 0, 0, 0], 8); // bit depth 1, colour type 3 (indexed), deflate, no filter, no interlace

  const { background: bg, foreground: fg } = style;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("PLTE", new Uint8Array([bg.r, bg.g, bg.b, fg.r, fg.g, fg.b])),
  ];
  if (bg.a < 255 || fg.a < 255) parts.push(chunk("tRNS", new Uint8Array([bg.a, fg.a])));
  parts.push(chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array(0)));

  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
