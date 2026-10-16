/**
 * Version handling for GameMaker libraries and runtimes. Libraries mostly use semver,
 * but tags and macros also look like "v0.5.0", "1.03.01", "6.4.2-beta" or "2023.1.1.81".
 */

export interface ParsedVersion {
  core: number[];
  pre: string[];
}

export type UpdateType = "major" | "minor" | "patch";

export function parseVersion(version: string): ParsedVersion | undefined {
  const m = /^\s*v?(\d+(?:\.\d+)*)(?:[-_]?((?:alpha|beta|rc|pre|preview|dev)[0-9A-Za-z.-]*)|-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/i.exec(version);
  if (!m) return undefined;
  const pre = m[2] ?? m[3];
  return { core: m[1].split(".").map(Number), pre: pre ? pre.split(".") : [] };
}

/** Normalised display form: no leading "v". */
export function cleanVersion(version: string): string {
  return version.trim().replace(/^v(?=\d)/i, "");
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1, 0 or 1. Missing components count as 0, and a pre-release sorts before its release. Unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdentifiers(x.pre[i], y.pre[i]);
    if (order !== 0) return order;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0;
}

export function updateType(from: string, to: string): UpdateType {
  const x = parseVersion(from)?.core ?? [];
  const y = parseVersion(to)?.core ?? [];
  if ((x[0] ?? 0) !== (y[0] ?? 0)) return "major";
  if ((x[1] ?? 0) !== (y[1] ?? 0)) return "minor";
  return "patch";
}

/**
 * Compares GameMaker versions (year.release.patch.build) on their first `components` parts.
 * IDE and runtime builds of one release have different build numbers (IDE 2023.1.1.62 ships
 * runtime 2023.1.1.81), so compatibility checks ignore the build.
 */
export function compareGameMaker(a: string, b: string, components = 3): number {
  const x = (parseVersion(a)?.core ?? []).slice(0, components);
  const y = (parseVersion(b)?.core ?? []).slice(0, components);
  for (let i = 0; i < components; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** "2023.1", from "2023.1.1.81". */
export function releaseLine(version: string): string {
  return (parseVersion(version)?.core ?? []).slice(0, 2).join(".");
}

/** LTS release lines are numbered year.0 (2022.0, 2026.0). */
export function isLts(version: string): boolean {
  const core = parseVersion(version)?.core ?? [];
  return core[0] >= 2022 && core[1] === 0;
}

/** Matches a version against an ignore pattern: "3.x", "2.1.*", "^2" style prefixes or an exact version. */
export function versionMatches(version: string, pattern: string): boolean {
  const p = cleanVersion(pattern).replace(/^\^/, "");
  if (p === "*" || p === "x") return true;
  const parts = p.split(".");
  if (parts.some((s) => s === "x" || s === "*") || parts.length < 3) {
    const v = parseVersion(version)?.core ?? [];
    return parts.every((s, i) => s === "x" || s === "*" || Number(s) === (v[i] ?? 0));
  }
  return compareVersions(version, p) === 0;
}
