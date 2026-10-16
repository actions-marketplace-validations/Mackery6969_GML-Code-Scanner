import type { UpdateCheckResult } from "../deps/updates.ts";
import type { ScanResult } from "../engine/scanner.ts";
import type { Finding, Severity } from "../engine/types.ts";
import { formatDependenciesText } from "./dependencies.ts";

export interface TextOptions {
  color: boolean;
  /** Show data-flow paths for security findings. */
  showPaths?: boolean;
  /** Dependency update check results, listed after the findings. */
  updates?: UpdateCheckResult;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  underline: "\x1b[4m",
};

export function formatText(result: ScanResult, options: TextOptions): string {
  const c = (code: keyof typeof ANSI, s: string) => (options.color ? ANSI[code] + s + ANSI.reset : s);
  const sevColor: Record<Severity, keyof typeof ANSI> = { error: "red", warning: "yellow", note: "blue" };
  const lines: string[] = [];
  const byFile = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const list = byFile.get(f.location.file) ?? [];
    list.push(f);
    byFile.set(f.location.file, list);
  }
  for (const [file, findings] of byFile) {
    lines.push("", c("underline", file));
    for (const f of findings) {
      const pos = `${f.location.startLine}:${f.location.startColumn}`.padEnd(8);
      lines.push(`  ${c("dim", pos)} ${c(sevColor[f.severity], f.severity.padEnd(7))} ${f.message}  ${c("dim", f.ruleId)}`);
      if (f.snippet) lines.push(`  ${" ".repeat(8)} ${c("dim", "│ " + truncate(f.snippet, 110))}`);
      if (options.showPaths && f.flow && f.flow.length > 1) {
        f.flow.forEach((s, i) => {
          const arrow = i === 0 ? "source" : i === f.flow!.length - 1 ? "sink  " : "step  ";
          lines.push(`  ${" ".repeat(8)} ${c("cyan", arrow)} ${c("dim", `${s.location.file}:${s.location.startLine}`)} ${s.message}`);
        });
      }
    }
  }
  const counts = { error: 0, warning: 0, note: 0 };
  for (const f of result.findings) counts[f.severity]++;
  const total = result.findings.length;
  if (options.updates) {
    const deps = formatDependenciesText(options.updates, c);
    if (deps) lines.push(deps.replace(/\n$/, ""));
  }
  lines.push("");
  for (const p of result.projects) {
    const data = !p.runtimeChecks ? " (no data for this release line, so availability checks are off; see runtime-dir)" : p.runtimeData !== p.runtime ? ` (checked against runtime ${p.runtimeData})` : "";
    const rt = p.runtime ? `, runtime ${p.runtime}${data}` : "";
    lines.push(c("dim", `Project ${p.name}${p.yyp ? ` (${p.yyp})` : " (no .yyp)"}: ${p.files} GML files${rt}`));
  }
  const summary = `${total} problem${total === 1 ? "" : "s"} (${counts.error} error${counts.error === 1 ? "" : "s"}, ${counts.warning} warning${counts.warning === 1 ? "" : "s"}, ${counts.note} note${counts.note === 1 ? "" : "s"}) in ${result.filesScanned} files, ${result.rules.length} rules, ${(result.durationMs / 1000).toFixed(1)}s`;
  lines.push(total === 0 ? c("green", `✔ ${summary}`) : c(counts.error ? "red" : "yellow", c("bold", `✖ ${summary}`)));
  for (const e of result.internalErrors.slice(0, 5)) lines.push(c("yellow", `internal error in ${e.ruleId}${e.file ? ` (${e.file})` : ""}: ${e.message.split("\n")[0]}`));
  return lines.join("\n") + "\n";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
