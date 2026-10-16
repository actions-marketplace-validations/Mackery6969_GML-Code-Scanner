import type { AutoUpdateResult } from "../deps/autoupdate.ts";
import { sourceUrl } from "../deps/registry.ts";
import type { Candidate, DependencyReport, UpdateCheckResult } from "../deps/updates.ts";

function blockedReason(c: Candidate): string {
  if (c.requirement?.legacyOnly) return "is only for GameMaker Studio 2.2 and older";
  if (c.requirement?.minimum) return `needs GameMaker ${c.requirement.minimum}+`;
  return "couldn't be checked against this project's GameMaker";
}

export function installedText(r: DependencyReport): string {
  const d = r.dependency;
  if (d.kind === "generated") return d.generatedAt ? `generated ${d.generatedAt}` : "unknown";
  return d.version ?? "unknown";
}

/** One-line status, e.g. "2.2.1 available (major)" or "up to date". */
export function statusText(r: DependencyReport): string {
  switch (r.status) {
    case "up-to-date":
      return "up to date";
    case "outdated": {
      const u = r.update!;
      let s = `${u.release.version} available${u.updateType ? ` (${u.updateType})` : ""}`;
      if (u.needsRuntime) s += `, ${blockedReason(u)}`;
      if (r.latest) s += `; ${r.latest.release.version} ${blockedReason(r.latest)}`;
      return s;
    }
    case "needs-runtime":
    case "unverified":
      return r.latest ? `${r.latest.release.version} ${blockedReason(r.latest)}` : "newer versions exist";
    case "unknown-version":
      return "installed version unknown";
    case "untracked":
      return "not tracked";
    case "ignored":
      return "ignored";
    case "error":
      return `check failed: ${r.error}`;
  }
}

const KIND: Record<string, string> = { extension: "extension", library: "library", generated: "generated script" };

export function formatDependenciesText(updates: UpdateCheckResult, c: (code: "dim" | "yellow" | "green" | "blue", s: string) => string): string {
  const lines: string[] = [];
  const shown = updates.reports.filter((r) => r.status !== "untracked" || r.dependency.version);
  if (shown.length === 0 && updates.runtimes.every((r) => r.available.length === 0)) return "";
  lines.push("", c("dim", "Dependencies"));
  const width = Math.max(10, ...shown.map((r) => `${r.dependency.name} ${installedText(r)}`.length));
  for (const r of shown) {
    const name = `${r.dependency.name} ${installedText(r)}`.padEnd(width);
    const status = statusText(r);
    const color = r.status === "outdated" ? "yellow" : r.status === "up-to-date" ? "green" : "dim";
    lines.push(`  ${name}  ${c(color, status)}  ${c("dim", r.dependency.location.file)}`);
  }
  for (const rt of updates.runtimes) {
    if (rt.available.length) lines.push(`  ${`GameMaker ${rt.target.version}`.padEnd(width)}  ${c("yellow", `${rt.available.map((a) => a.version).join(", ")} available`)}`);
  }
  for (const e of updates.errors) lines.push(c("yellow", `  update check failed for ${e}`));
  return lines.join("\n") + "\n";
}

const escapeCell = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown section for the job summary. */
export function formatDependencySummary(updates: UpdateCheckResult, autoUpdate?: AutoUpdateResult): string {
  const rows = updates.reports.filter((r) => r.status !== "untracked" || r.dependency.version);
  if (rows.length === 0 && updates.runtimes.every((r) => r.available.length === 0)) return "";
  const out = ["### Dependencies", "", "| Dependency | Installed | Status |", "|---|---|---|"];
  const order: Record<string, number> = { outdated: 0, "needs-runtime": 1, unverified: 2, error: 3, "up-to-date": 4, "unknown-version": 5, ignored: 6, untracked: 7 };
  for (const r of [...rows].sort((a, b) => order[a.status] - order[b.status] || a.dependency.name.localeCompare(b.dependency.name))) {
    const d = r.dependency;
    const name = d.spec ? `[${escapeCell(d.name)}](${sourceUrl(d.spec.source)})` : escapeCell(d.name);
    let status = escapeCell(statusText(r));
    if (r.status === "outdated") {
      status = `🔵 ${status} · [release](${r.update!.release.url})`;
      const pr = autoUpdate?.opened.find((p) => p.dependency === d.name && p.to === r.update!.release.version);
      if (pr) status += ` · [#${pr.number}](${pr.url})`;
    } else if (r.status === "up-to-date") status = `✅ ${status}`;
    out.push(`| ${name} (${KIND[d.kind]}) | ${escapeCell(installedText(r))} | ${status} |`);
  }
  for (const rt of updates.runtimes) {
    if (rt.available.length) out.push(`| GameMaker runtime | ${rt.target.version} | 🔵 ${rt.available.map((a) => (a.kind === "lts" ? `${a.version} (LTS)` : a.version)).join(", ")} available |`);
  }
  if (updates.errors.length) out.push("", ...updates.errors.map((e) => `> ⚠️ Update check failed for ${escapeCell(e)}`));
  if (rows.some((r) => r.status === "untracked")) out.push("", "Extensions marked *not tracked* aren't in the scanner's list. Add them under `dependencies.sources` in `.gmlscan.json` to check them for updates.");
  return out.join("\n") + "\n";
}

/** Plain JSON for `--format json` (no project back-references). */
export function dependencyReportsJson(updates: UpdateCheckResult): unknown {
  const candidate = (c: Candidate | undefined) =>
    c && {
      version: c.release.version,
      url: c.release.url,
      publishedAt: c.release.publishedAt,
      requires: c.requirement?.minimum,
      compatible: c.compatible,
    };
  return {
    dependencies: updates.reports.map((r) => ({
      project: r.dependency.project.name,
      kind: r.dependency.kind,
      name: r.dependency.name,
      version: r.dependency.version,
      generatedAt: r.dependency.generatedAt,
      file: r.dependency.location.file,
      line: r.dependency.location.startLine,
      source: r.dependency.spec ? sourceUrl(r.dependency.spec.source) : undefined,
      status: r.status,
      runtime: r.runtime,
      update: r.update && { ...candidate(r.update), updateType: r.update.updateType, needsRuntime: r.update.needsRuntime },
      latest: candidate(r.latest),
      error: r.error,
    })),
    runtimes: updates.runtimes.map((r) => ({ project: r.target.project.name, version: r.target.version, available: r.available })),
    errors: updates.errors,
  };
}
