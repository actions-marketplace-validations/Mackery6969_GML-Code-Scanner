/**
 * Looks up published versions: GitHub and Codeberg releases, GameMaker Marketplace asset
 * pages, package metadata inside .yymps files, and GameMaker's runtime release feeds.
 */
import type { DependencySource, DependencySpec } from "./registry.ts";
import { cleanVersion, compareVersions, parseVersion } from "./version.ts";
import { RemoteZip, type FetchLike } from "./zip.ts";

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  /** Version without a leading "v". */
  version: string;
  tag?: string;
  prerelease: boolean;
  /** ISO date. */
  publishedAt?: string;
  /** Release page. */
  url: string;
  /** Release notes (Markdown). */
  notes?: string;
  assets: ReleaseAsset[];
  /** The .yymps holding this dependency, when the release has one. */
  packageAsset?: ReleaseAsset;
  /** Marketplace version label: GMS1, GMS2 (2.2 and older) or GMS2.3. */
  label?: string;
  /** Where it was published, when that isn't the dependency's main source. */
  source?: DependencySource;
}

export interface PackageMetadata {
  packageId?: string;
  version?: string;
  /** IDE the package was exported from; projects need at least this release. */
  ideVersion?: string;
}

export interface HttpOptions {
  fetch: FetchLike;
  /** Sent to api.github.com only. */
  githubToken?: string;
}

export class SourceError extends Error {}

const GITHUB_API = "https://api.github.com";
const CODEBERG_API = "https://codeberg.org/api/v1";
const USER_AGENT = "gml-code-scanner";
const REQUEST_TIMEOUT_MS = 20_000;

async function getJson(url: string, http: HttpOptions, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await http.fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new SourceError(`${new URL(url).host} rate limit reached${http.githubToken ? "" : "; set GITHUB_TOKEN to raise it"}`);
    }
    throw new SourceError(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

interface ApiRelease {
  tag_name: string;
  name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  html_url: string;
  body?: string;
  assets?: { name: string; size: number; browser_download_url: string }[];
}

function toReleases(raw: ApiRelease[], spec: DependencySpec): Release[] {
  const assetRe = spec.asset ? new RegExp(spec.asset, "i") : /\.yymps$/i;
  const out: Release[] = [];
  for (const r of raw) {
    if (r.draft) continue;
    const assets = (r.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
    const packageAsset = assets.find((a) => assetRe.test(a.name));
    // Repositories that ship several packages per release give each its own version in the asset name.
    const assetVersion = packageAsset && spec.asset ? assetRe.exec(packageAsset.name)?.[1] : undefined;
    if (spec.asset && !packageAsset) continue;
    const version = assetVersion ?? r.tag_name;
    if (!parseVersion(version)) continue;
    out.push({
      version: cleanVersion(version),
      tag: r.tag_name,
      prerelease: r.prerelease === true,
      publishedAt: r.published_at,
      url: r.html_url,
      notes: r.body ?? undefined,
      assets,
      packageAsset,
    });
  }
  return out;
}

async function githubReleases(repo: string, spec: DependencySpec, http: HttpOptions): Promise<Release[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (http.githubToken) headers.Authorization = `Bearer ${http.githubToken}`;
  const raw = (await getJson(`${GITHUB_API}/repos/${repo}/releases?per_page=100`, http, headers)) as ApiRelease[] | undefined;
  if (raw === undefined) throw new SourceError(`repository ${repo} not found on GitHub`);
  if (raw.length > 0 || spec.asset) return toReleases(raw, spec);
  // Some libraries only push tags.
  const tags = ((await getJson(`${GITHUB_API}/repos/${repo}/tags?per_page=100`, http, headers)) as { name: string }[] | undefined) ?? [];
  return toReleases(
    tags.map((t) => ({ tag_name: t.name, html_url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(t.name)}` })),
    spec,
  );
}

async function codebergReleases(repo: string, spec: DependencySpec, http: HttpOptions): Promise<Release[]> {
  const raw = (await getJson(`${CODEBERG_API}/repos/${repo}/releases?limit=50`, http)) as ApiRelease[] | undefined;
  if (raw === undefined) throw new SourceError(`repository ${repo} not found on Codeberg`);
  return toReleases(raw, spec);
}

/**
 * Reads the version history from a Marketplace asset page. Each entry reads like
 * "GMS2.3 - Version 1.0.76. Published May 25, 2024" (the label is missing on some assets).
 */
export function parseMarketplacePage(html: string, assetUrl: string): Release[] {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const out: Release[] = [];
  const re = /(?:\b(GMS?[\d.]*)\s*-\s*)?Version\s+(\d[\w.-]*?)\.?\s+Published\s+([A-Z][a-z]+ \d{1,2}, \d{4})/g;
  for (const m of text.matchAll(re)) {
    const date = new Date(`${m[3]} UTC`);
    out.push({
      version: cleanVersion(m[2]),
      prerelease: false,
      publishedAt: Number.isNaN(date.getTime()) ? undefined : date.toISOString(),
      url: assetUrl,
      assets: [],
      label: m[1],
    });
  }
  return out;
}

async function marketplaceReleases(id: number, http: HttpOptions): Promise<Release[]> {
  const url = `https://marketplace.gamemaker.io/assets/${id}`;
  const res = await http.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new SourceError(`HTTP ${res.status} from ${url}`);
  const releases = parseMarketplacePage(await res.text(), res.url || url);
  if (releases.length === 0) throw new SourceError(`no versions found on ${url}`);
  return releases;
}

function releasesFrom(source: DependencySource, spec: DependencySpec, http: HttpOptions): Promise<Release[]> {
  switch (source.type) {
    case "github":
      return githubReleases(source.repo, spec, http);
    case "codeberg":
      return codebergReleases(source.repo, spec, http);
    case "marketplace":
      return marketplaceReleases(source.id, http);
  }
}

/** Published versions of a dependency, newest first. */
export async function fetchReleases(spec: DependencySpec, http: HttpOptions): Promise<Release[]> {
  const releases = await releasesFrom(spec.source, spec, http);
  const seen = new Set(releases.map((r) => r.version));
  for (const previous of spec.previousSources ?? []) {
    // Older releases are a bonus: if their old home is gone, carry on without them.
    const older = await releasesFrom(previous, spec, http).catch(() => []);
    for (const r of older) if (!seen.has(r.version)) releases.push({ ...r, source: previous });
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/** Reads metadata.json from a .yymps without downloading the rest of the package. */
export async function fetchPackageMetadata(asset: ReleaseAsset, http: HttpOptions): Promise<PackageMetadata> {
  const zip = new RemoteZip(asset.url, asset.size, (url, init) => http.fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "User-Agent": USER_AGENT } }));
  const entry = (await zip.entries()).find((e) => e.name === "metadata.json");
  if (!entry) return {};
  const json = JSON.parse((await zip.read(entry)).toString("utf8").replace(/^﻿/, "")) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { packageId: str(json.package_id), version: str(json.version), ideVersion: str(json.ide_version) };
}

/** GameMaker's runtime release feeds: the monthly releases and each LTS line. */
export const RUNTIME_FEEDS = [
  "https://gms.yoyogames.com/Zeus-Runtime.rss",
  "https://gms.yoyogames.com/Zeus-Runtime-LTS.rss",
  "https://gms.yoyogames.com/Zeus-Runtime-LTS2026.rss",
];

export function parseRuntimeFeed(xml: string): string[] {
  return [...xml.matchAll(/<title>\s*Version\s+(\d+(?:\.\d+){2,3})\s*<\/title>/g)].map((m) => m[1]);
}

/** Every published runtime version, newest first. */
export async function fetchRuntimeVersions(http: HttpOptions): Promise<string[]> {
  const versions = new Set<string>();
  const results = await Promise.allSettled(
    RUNTIME_FEEDS.map(async (url) => {
      const res = await http.fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new SourceError(`HTTP ${res.status} from ${url}`);
      for (const v of parseRuntimeFeed(await res.text())) versions.add(v);
    }),
  );
  if (versions.size === 0) {
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw new SourceError(failure ? String(failure.reason?.message ?? failure.reason) : "the runtime feeds list no versions");
  }
  return [...versions].sort((a, b) => compareVersions(b, a));
}
