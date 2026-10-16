/**
 * Checks the dependencies a scan found against their published releases and turns
 * compatible updates into `gml/outdated-dependency` findings (and, when runtime updates are
 * on, newer GameMaker runtimes into `gml/runtime-update`). Runs after the scan because it
 * needs the network; any lookup that fails is reported and skipped, never fatal.
 */
import type { DependencyIgnore } from "../engine/config.ts";
import { dedupeAndSort, selectRules, type ScanResult } from "../engine/scanner.ts";
import { Suppressions } from "../engine/suppress.ts";
import type { Finding, RuleMeta, Severity } from "../engine/types.ts";
import { DEPENDENCY_RULES } from "../rules/dependencies.ts";
import { isCompatible, requirementOf, type Requirement } from "./compat.ts";
import type { DetectedDependency, RuntimeTarget } from "./detect.ts";
import { describeSource, type DependencySpec } from "./registry.ts";
import { fetchPackageMetadata, fetchReleases, fetchRuntimeVersions, type HttpOptions, type PackageMetadata, type Release, type ReleaseAsset } from "./sources.ts";
import { compareGameMaker, compareVersions, isLts, isPrerelease, parseVersion, releaseLine, updateType, versionMatches, type UpdateType } from "./version.ts";

export type DependencyStatus =
  /** Nothing newer is published. */
  | "up-to-date"
  /** A newer release supports the project's GameMaker version (or runtime updates are on). */
  | "outdated"
  /** Newer releases exist, but all of them need a newer GameMaker. */
  | "needs-runtime"
  /** Newer releases exist, but the scanner couldn't tell whether they support the project's GameMaker. */
  | "unverified"
  /** The project doesn't record which version it has. */
  | "unknown-version"
  /** An extension the scanner has no source for. */
  | "untracked"
  | "ignored"
  | "error";

export interface Candidate {
  release: Release;
  requirement?: Requirement;
  compatible?: boolean;
}

export interface DependencyReport {
  dependency: DetectedDependency;
  status: DependencyStatus;
  /** GameMaker version the dependency's project targets. */
  runtime?: string;
  /** Newest release the project can move to (status "outdated"). */
  update?: Candidate & {
    updateType?: UpdateType;
    /** Only usable after updating GameMaker (reported because runtime updates are on). */
    needsRuntime?: boolean;
  };
  /** Newest release overall, when it is newer than `update`. */
  latest?: Candidate;
  error?: string;
}

export interface RuntimeReport {
  target: RuntimeTarget;
  /** Newer runtimes, most relevant first: a patch of the same release, then newer release lines. */
  available: { version: string; kind: "patch" | "lts" | "monthly" }[];
}

export interface UpdateCheckOptions {
  http: HttpOptions;
  runtimeUpdates?: boolean;
  /** Only run these rule ids (like the scanner's --rule). */
  onlyRules?: string[];
  /** Package metadata downloads per dependency (each is two or three small range requests). */
  maxMetadataLookups?: number;
}

export interface UpdateCheckResult {
  reports: DependencyReport[];
  runtimes: RuntimeReport[];
  findings: Finding[];
  /** Metadata for the rules that produced findings (to add to the SARIF). */
  rules: RuleMeta[];
  /** Lookups that failed, e.g. "Scribble: HTTP 502 from ...". */
  errors: string[];
}

const DAY = 24 * 60 * 60 * 1000;
/**
 * A generated script (GMLive) is built shortly before its version is published, so a release
 * only counts as newer when it came out well after the installed copy was generated.
 */
const GENERATED_GRACE_DAYS = 30;

const lower = (s: string) => s.toLowerCase();

function ignoreApplies(dep: DetectedDependency, rule: DependencyIgnore): boolean {
  const names = [dep.name, dep.spec?.name, dep.extension?.name, ...(dep.spec?.macros ?? [])];
  return names.some((n) => n !== undefined && lower(n) === lower(rule.name));
}

function ignoredEntirely(dep: DetectedDependency, ignore: DependencyIgnore[]): boolean {
  return ignore.some((i) => ignoreApplies(dep, i) && !i.versions?.length && !i.updateTypes?.length);
}

function ignoredVersion(dep: DetectedDependency, version: string, ignore: DependencyIgnore[]): boolean {
  return ignore.some((i) => {
    if (!ignoreApplies(dep, i) || (!i.versions?.length && !i.updateTypes?.length)) return false;
    if (i.versions?.length && !i.versions.some((p) => versionMatches(version, p))) return false;
    if (i.updateTypes?.length && !(dep.version && i.updateTypes.includes(updateType(dep.version, version)))) return false;
    return true;
  });
}

function specKey(spec: DependencySpec): string {
  return JSON.stringify([spec.source, spec.asset ?? ""]);
}

/** Small concurrency pool: these are network-bound and the lists are short. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function checkUpdates(result: ScanResult, options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const config = result.config.dependencies;
  const runtimeUpdates = options.runtimeUpdates ?? config.runtimeUpdates;
  const maxLookups = options.maxMetadataLookups ?? 10;
  const errors: string[] = [];

  const releaseCache = new Map<string, Promise<Release[]>>();
  const releasesOf = (spec: DependencySpec) => {
    const key = specKey(spec);
    if (!releaseCache.has(key)) releaseCache.set(key, fetchReleases(spec, options.http));
    return releaseCache.get(key)!;
  };
  const metadataCache = new Map<string, Promise<PackageMetadata | undefined>>();
  const metadataOf = (asset: ReleaseAsset) => {
    if (!metadataCache.has(asset.url)) metadataCache.set(asset.url, fetchPackageMetadata(asset, options.http).catch(() => undefined));
    return metadataCache.get(asset.url)!;
  };
  const runtimeOf = (dep: DetectedDependency) => result.runtimes.find((r) => r.project === dep.project);

  const evaluate = async (dep: DetectedDependency): Promise<DependencyReport> => {
    if (!dep.spec) return { dependency: dep, status: "untracked" };
    if (ignoredEntirely(dep, config.ignore)) return { dependency: dep, status: "ignored" };
    let releases: Release[];
    try {
      releases = await releasesOf(dep.spec);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${dep.name}: ${message}`);
      return { dependency: dep, status: "error", error: message };
    }

    let candidates: Release[];
    if (dep.kind === "generated") {
      if (!dep.generatedAt) return { dependency: dep, status: "unknown-version" };
      const cutoff = Date.parse(dep.generatedAt) + GENERATED_GRACE_DAYS * DAY;
      candidates = releases.filter((r) => r.publishedAt && Date.parse(r.publishedAt) > cutoff);
    } else {
      const installed = dep.version;
      if (!installed || !parseVersion(installed)) return { dependency: dep, status: "unknown-version" };
      const allowPrerelease = isPrerelease(installed);
      candidates = releases.filter((r) => compareVersions(r.version, installed) > 0 && (allowPrerelease || (!r.prerelease && !isPrerelease(r.version))));
    }
    const runtime = runtimeOf(dep)?.version;
    // Marketplace versions for GameMaker Studio 2.2 and older (GMS1, GMS2) don't apply to 2.3+ projects.
    const modern = !runtime || compareGameMaker(runtime, "2.3.0") >= 0;
    candidates = candidates.filter((r) => !ignoredVersion(dep, r.version, config.ignore) && !(modern && r.label && /^GMS?[12]$/i.test(r.label)));
    if (candidates.length === 0) return { dependency: dep, status: "up-to-date" };

    let lookups = 0;
    let blocked = false;
    const evaluated = new Map<number, Candidate>();
    const candidateAt = async (i: number): Promise<Candidate> => {
      const cached = evaluated.get(i);
      if (cached) return cached;
      const release = candidates[i];
      let metadata: PackageMetadata | undefined;
      if (release.packageAsset && lookups < maxLookups) {
        lookups++;
        metadata = await metadataOf(release.packageAsset);
      }
      const requirement = requirementOf(release, metadata);
      const candidate: Candidate = { release, requirement, compatible: isCompatible(requirement, runtime) };
      if (candidate.compatible === false) blocked = true;
      evaluated.set(i, candidate);
      return candidate;
    };

    const latest = await candidateAt(0);
    let update: DependencyReport["update"];
    if (latest.compatible === true) update = latest;
    else {
      // Requirements only grow with newer versions, so binary-search (newest first) for the
      // newest release that supports the project's GameMaker. Unknowns count as unsupported.
      let lo = 1;
      let hi = candidates.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = await candidateAt(mid);
        if (c.compatible === true) {
          update = c;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      // Nothing works with the current runtime: with runtime updates on, suggest the newest anyway.
      if (!update && latest.compatible === false && runtimeUpdates && latest.requirement?.minimum && !latest.requirement.legacyOnly) update = { ...latest, needsRuntime: true };
    }
    if (update && dep.version && dep.kind !== "generated") update.updateType = updateType(dep.version, update.release.version);
    const newer = latest && latest.release !== update?.release ? latest : undefined;
    if (update) return { dependency: dep, status: "outdated", update, latest: newer };
    return { dependency: dep, status: blocked ? "needs-runtime" : "unverified", latest };
  };

  const reports = await mapLimit(result.dependencies, 4, async (dep) => ({ ...(await evaluate(dep)), runtime: runtimeOf(dep)?.version }));

  const runtimes: RuntimeReport[] = [];
  if (runtimeUpdates && result.runtimes.length) {
    try {
      const versions = await fetchRuntimeVersions(options.http);
      for (const target of result.runtimes) runtimes.push({ target, available: newerRuntimes(target, versions) });
    } catch (e) {
      errors.push(`GameMaker runtimes: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const selected = selectRules(result.config, DEPENDENCY_RULES, options.onlyRules).filter((s) => runtimeUpdates || s.rule.meta.id !== "gml/runtime-update");
  const severityOf = new Map<string, Severity>(selected.map((s) => [s.rule.meta.id, s.severity]));
  const findings: Finding[] = [];
  const outdatedSeverity = severityOf.get("gml/outdated-dependency");
  if (outdatedSeverity) {
    for (const r of reports) {
      if (r.status !== "outdated") continue;
      const d = r.dependency;
      findings.push({ ruleId: "gml/outdated-dependency", severity: outdatedSeverity, message: outdatedMessage(r, runtimeOf(d)), location: d.location, snippet: d.snippet });
    }
  }
  const runtimeSeverity = severityOf.get("gml/runtime-update");
  if (runtimeSeverity) {
    for (const r of runtimes) {
      if (!r.available.length || !r.target.location) continue;
      findings.push({ ruleId: "gml/runtime-update", severity: runtimeSeverity, message: runtimeMessage(r), location: r.target.location, snippet: r.target.snippet });
    }
  }

  return { reports, runtimes, findings: suppress(findings, result), rules: selected.map((s) => s.rule.meta), errors };
}

/** Adds the update check's findings and rules to a scan result. */
export function mergeUpdateFindings(result: ScanResult, updates: UpdateCheckResult): void {
  result.findings = dedupeAndSort([...result.findings, ...updates.findings]);
  for (const meta of updates.rules) if (!result.rules.some((m) => m.id === meta.id)) result.rules.push(meta);
}

/** Inline `gmlscan-ignore` comments work on version macros too. */
function suppress(findings: Finding[], result: ScanResult): Finding[] {
  const cache = new Map<string, Suppressions | undefined>();
  const forFile = (relPath: string) => {
    if (!cache.has(relPath)) {
      const file = result.dependencies.map((d) => d.project.files.find((f) => f.relPath === relPath)).find(Boolean);
      cache.set(relPath, file ? Suppressions.fromComments(file.ast.comments, file.source) : undefined);
    }
    return cache.get(relPath);
  };
  return findings.filter((f) => !forFile(f.location.file)?.isSuppressed(f.ruleId, f.location.startLine));
}

export function newerRuntimes(target: RuntimeTarget, versions: string[]): RuntimeReport["available"] {
  const out: RuntimeReport["available"] = [];
  // An IDEVersion's build number isn't comparable to runtime builds; an explicit runtime's is.
  const parts = target.explicit ? 4 : 3;
  const line = releaseLine(target.version);
  const sameLine = versions.find((v) => releaseLine(v) === line);
  if (sameLine && compareGameMaker(sameLine, target.version, parts) > 0) out.push({ version: sameLine, kind: "patch" });
  const lts = versions.find((v) => isLts(v));
  if (lts && compareGameMaker(lts, target.version, 2) > 0) out.push({ version: lts, kind: "lts" });
  const monthly = versions.find((v) => !isLts(v));
  if (monthly && compareGameMaker(monthly, target.version, 2) > 0) out.push({ version: monthly, kind: "monthly" });
  return out;
}

function runtimeMessage(r: RuntimeReport): string {
  const label = (a: RuntimeReport["available"][number]) => (a.kind === "patch" ? `${a.version} (an update to this release)` : a.kind === "lts" ? `${a.version} (LTS)` : a.version);
  const list = r.available.map(label);
  const joined = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `${list.length === 1 ? "A newer GameMaker runtime is available" : "Newer GameMaker runtimes are available"}: ${joined}. This project targets ${r.target.version}.`;
}

function requirementText(c: Candidate): string {
  if (c.requirement?.legacyOnly) return "is only for GameMaker Studio 2.2 and older";
  return c.requirement?.minimum ? `needs GameMaker ${c.requirement.minimum} or later` : "may not support this project's GameMaker version";
}

export function outdatedMessage(r: DependencyReport, runtime: RuntimeTarget | undefined): string {
  const d = r.dependency;
  const u = r.update!;
  const where = describeSource(u.release.source ?? d.spec!.source);
  const published = u.release.publishedAt ? ` (published ${u.release.publishedAt.slice(0, 10)})` : "";
  let msg =
    d.kind === "generated"
      ? `${d.name} here was generated on ${d.generatedAt}; version ${u.release.version}${published} is on ${where}.`
      : `${d.name} ${d.version} can be updated to ${u.release.version}${published} from ${where}.`;
  if (u.needsRuntime) msg += ` It ${requirementText(u)}; this project targets ${runtime?.version ?? "an older version"}.`;
  if (r.latest) {
    const reason = r.latest.compatible === undefined ? "couldn't be checked against this project's GameMaker version" : requirementText(r.latest);
    msg += ` ${r.latest.release.version} is out too, but ${reason}.`;
  }
  return msg;
}
