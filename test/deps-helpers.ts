import { deflateRawSync } from "node:zlib";
import type { FetchLike } from "../src/deps/zip.ts";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a zip archive (deflated entries, or stored when `store` is set). */
export function makeZip(files: Record<string, string | Buffer>, options: { store?: boolean; comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const method = options.store ? 0 : 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type Route = (req: FakeRequest) => Response | undefined | Promise<Response | undefined>;

export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** Serves a binary file, honouring `Range: bytes=a-b` unless `ignoreRanges` is set. */
export function file(content: Buffer, req: FakeRequest, ignoreRanges = false): Response {
  const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? req.headers.Range ?? "");
  if (!range || ignoreRanges) return new Response(new Uint8Array(content), { status: 200 });
  const start = Number(range[1]);
  const end = Math.min(Number(range[2]), content.length - 1);
  return new Response(new Uint8Array(content.subarray(start, end + 1)), { status: 206 });
}

/** A `fetch` that answers from routes (first non-undefined wins) and records every request. */
export function fakeFetch(...routes: Route[]): { fetch: FetchLike; requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const req: FakeRequest = { method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    requests.push(req);
    for (const route of routes) {
      const res = await route(req);
      if (res) return res;
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, requests };
}

export function githubRelease(tag: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}`, published_at: "2025-01-01T00:00:00Z", prerelease: false, draft: false, body: "", assets: [], ...extra };
}

export function yymps(version: string, ideVersion: string, files: Record<string, string | Buffer> = {}): Buffer {
  return makeZip({ "metadata.json": JSON.stringify({ package_id: "pkg", display_name: "Pkg", version, package_type: "asset", ide_version: ideVersion }), ...files });
}
