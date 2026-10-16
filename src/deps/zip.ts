/**
 * Just enough of the zip format to read GameMaker packages (.yymps): the central directory,
 * stored and deflated entries, and reading single entries from a remote file with HTTP range
 * requests, so checking a package's metadata.json doesn't download the whole package.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record is 22 bytes plus a comment of up to 65535. */
const MAX_EOCD = 22 + 0xffff;

export class ZipError extends Error {}

interface Eocd {
  count: number;
  cdSize: number;
  cdOffset: number;
}

function findEocd(buf: Buffer): Eocd {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - MAX_EOCD); i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    const cdOffset = buf.readUInt32LE(i + 16);
    if (cdOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
    return { count: buf.readUInt16LE(i + 10), cdSize: buf.readUInt32LE(i + 12), cdOffset };
  }
  throw new ZipError("not a zip file (no end of central directory)");
}

function parseCentralDirectory(cd: Buffer, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new ZipError("corrupt central directory");
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.toString("utf8", p + 46, p + 46 + nameLength).replace(/\\/g, "/"),
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localHeaderOffset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompresses an entry from a buffer that starts at its local header. */
function decode(entry: ZipEntry, local: Buffer): Buffer {
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ZipError(`corrupt local header for ${entry.name}`);
  const dataStart = 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = local.subarray(dataStart, dataStart + entry.compressedSize);
  if (data.length < entry.compressedSize) throw new ZipError(`truncated entry ${entry.name}`);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new ZipError(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/** A zip archive held in memory. */
export class Zip {
  readonly entries: ZipEntry[];
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
    const eocd = findEocd(buf);
    this.entries = parseCentralDirectory(buf.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize), eocd.count);
  }

  read(entry: ZipEntry): Buffer {
    return decode(entry, this.buf.subarray(entry.localHeaderOffset));
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Reads entries of a zip file served over HTTP with range requests. Falls back to the whole
 * file when the server ignores ranges.
 */
export class RemoteZip {
  private whole: Buffer | undefined;
  private entriesCache: ZipEntry[] | undefined;
  private readonly url: string;
  private readonly size: number;
  private readonly fetchImpl: FetchLike;

  constructor(url: string, size: number, fetchImpl: FetchLike) {
    this.url = url;
    this.size = size;
    this.fetchImpl = fetchImpl;
  }

  private async range(start: number, end: number): Promise<Buffer> {
    end = Math.min(end, this.size - 1);
    if (this.whole) return this.whole.subarray(start, end + 1);
    const res = await this.fetchImpl(this.url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new ZipError(`HTTP ${res.status} reading ${this.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status === 206) return buf;
    this.whole = buf;
    return buf.subarray(start, end + 1);
  }

  async entries(): Promise<ZipEntry[]> {
    if (this.entriesCache) return this.entriesCache;
    const tailStart = Math.max(0, this.size - MAX_EOCD);
    const tail = await this.range(tailStart, this.size - 1);
    const eocd = findEocd(tail);
    const cd = eocd.cdOffset >= tailStart ? tail.subarray(eocd.cdOffset - tailStart, eocd.cdOffset - tailStart + eocd.cdSize) : await this.range(eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1);
    this.entriesCache = parseCentralDirectory(cd, eocd.count);
    return this.entriesCache;
  }

  async read(entry: ZipEntry): Promise<Buffer> {
    // The local header's name and extra field can differ from the central directory's; allow some slack.
    const slack = 30 + entry.name.length + 1024;
    let local = await this.range(entry.localHeaderOffset, entry.localHeaderOffset + slack + entry.compressedSize - 1);
    const needed = 30 + local.readUInt16LE(26) + local.readUInt16LE(28) + entry.compressedSize;
    if (local.length < needed) local = await this.range(entry.localHeaderOffset, entry.localHeaderOffset + needed - 1);
    return decode(entry, local);
  }
}
