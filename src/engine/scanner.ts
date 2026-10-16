import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectDependencies, detectRuntime, type DetectedDependency, type RuntimeTarget } from "../deps/detect.ts";
import { BUILTIN_DEPENDENCIES } from "../deps/registry.ts";
import type * as A from "../parser/ast.ts";
import { walk } from "../parser/walk.ts";
import { loadWorkspace, type GmlFile, type Project } from "../project/loader.ts";
import type { SourceText } from "../project/source.ts";
import { addRuntime, KNOWN_RUNTIMES } from "../semantic/builtins.ts";
import { ProjectIndex } from "../semantic/project-index.ts";
import type { RuntimeSpec } from "../semantic/runtime-spec.ts";
import { ALL_RULES, SYNTAX_ERROR_RULE } from "../rules/index.ts";
import { createPatternRules } from "../rules/patterns.ts";
import { loadConfig, type ResolvedConfig, type ThreatModel } from "./config.ts";
import { loadIgnoreMatcher } from "./ignore.ts";
import { Suppressions } from "./suppress.ts";
import type { FileContext, Finding, ProjectContext, ReportExtras, Rule, RuleMeta, Severity, SourceLocation, Span, Suite } from "./types.ts";

export interface ScanOptions {
  /** Directory to scan. */
  root: string;
  /** Explicit config file; otherwise `.gmlscan.json` etc. in `root` is used. */
  configPath?: string;
  /** Pre-resolved config (skips loading from disk). */
  config?: ResolvedConfig;
  /** Overrides the config's suite. */
  suite?: Suite;
  /** Only run these rule ids. */
  onlyRules?: string[];
  /** Overrides the target runtime version. */
  runtime?: string;
  /** An installed runtime (see loadRuntimeSpec) to check projects on its release line against. */
  runtimeSpec?: RuntimeSpec;
  /** Overrides the config's threat models. */
  threatModels?: ThreatModel[];
}

export interface ProjectSummary {
  name: string;
  yyp?: string;
  files: number;
  runtime?: string;
  runtimeChecks: boolean;
  /** The runtime version whose function data availability checks used. */
  runtimeData?: string;
}

export interface InternalError {
  ruleId: string;
  file?: string;
  message: string;
}

export interface ScanResult {
  findings: Finding[];
  /** Rules that ran (for SARIF rule metadata). */
  rules: RuleMeta[];
  projects: ProjectSummary[];
  filesScanned: number;
  durationMs: number;
  config: ResolvedConfig;
  internalErrors: InternalError[];
  /** Extensions and libraries found in the projects (versions are checked by src/deps/updates.ts). */
  dependencies: DetectedDependency[];
  /** The GameMaker version each project targets. */
  runtimes: RuntimeTarget[];
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression"]);

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, note: 2 };

/** Whether any finding is at or above `failOn` (error | warning | note | none). */
export function exceedsThreshold(result: ScanResult, failOn: string): boolean {
  if (failOn === "none") return false;
  const limit = SEVERITY_RANK[failOn as Severity];
  return result.findings.some((f) => SEVERITY_RANK[f.severity] <= limit);
}

export function isRuleInSuite(meta: RuleMeta, suite: Suite): boolean {
  switch (suite) {
    case "default":
      return meta.tier === "default";
    case "security-extended":
      return meta.tier === "default" || (meta.tier === "extended" && meta.category === "security");
    case "security-and-quality":
    case "all":
      return true;
  }
}

export function selectRules(config: ResolvedConfig, rules: Rule[], onlyRules?: string[]): { rule: Rule; severity: Severity }[] {
  const selected: { rule: Rule; severity: Severity }[] = [];
  for (const rule of rules) {
    const setting = config.rules[rule.meta.id];
    const level = typeof setting === "string" ? setting : setting?.severity;
    if (onlyRules && !onlyRules.includes(rule.meta.id)) continue;
    if (level === "off") continue;
    if (level === undefined && !onlyRules && !isRuleInSuite(rule.meta, config.suite)) continue;
    selected.push({ rule, severity: level ?? rule.meta.severity });
  }
  return selected;
}

export function scan(options: ScanOptions): ScanResult {
  const started = performance.now();
  const root = resolve(options.root);
  const config = { ...(options.config ?? loadConfig(root, options.configPath)) };
  if (options.suite) config.suite = options.suite;
  if (options.runtime) config.runtime = options.runtime;
  if (options.threatModels?.length) config.threatModels = options.threatModels;

  const rules = [...ALL_RULES, SYNTAX_ERROR_RULE, ...createPatternRules(config.patterns)];
  const selected = selectRules(config, rules, options.onlyRules);
  const severityOf = new Map(selected.map((s) => [s.rule.meta.id, s.severity]));
  if (options.runtimeSpec) addRuntime(options.runtimeSpec);
  const ignored = loadIgnoreMatcher(root, config.ignore);
  // A runtime installed inside the scanned folder (bscotch/igor-setup puts it in the workspace) isn't part of the game.
  const runtimeRel = options.runtimeSpec ? relative(root, resolve(options.runtimeSpec.dir)).split(sep).join("/") : "";
  const runtimeInside = runtimeRel !== "" && !runtimeRel.startsWith("..") && !isAbsolute(runtimeRel);
  const inRuntime = (p: string) => runtimeInside && (p === runtimeRel || p.startsWith(runtimeRel + "/"));
  const isIgnored = (p: string) => inRuntime(p) || ignored(p);
  const workspace = loadWorkspace(root, { isIgnored });

  const findings: Finding[] = [];
  const internalErrors: InternalError[] = [];
  const projects: ProjectSummary[] = [];
  const dependencies: DetectedDependency[] = [];
  const runtimes: RuntimeTarget[] = [];
  const dependencySpecs = [...config.dependencies.sources, ...BUILTIN_DEPENDENCIES];
  let filesScanned = 0;
  // CI workflows and .env files at the repository root are checked once, with the first project.
  workspace.projects[0]?.auxiliaryFiles.push(...workspace.auxiliaryFiles);

  for (const project of workspace.projects) {
    const index = new ProjectIndex(project, config.runtime);
    projects.push({
      name: project.name,
      yyp: project.yyp?.relPath,
      files: project.files.length,
      runtime: config.runtime ?? project.yyp?.ideVersion,
      runtimeChecks: index.runtimeIndex >= 0,
      runtimeData: KNOWN_RUNTIMES[index.runtimeIndex],
    });
    filesScanned += project.files.length;
    dependencies.push(...detectDependencies(project, dependencySpecs));
    const runtime = detectRuntime(project, config.runtime);
    if (runtime) runtimes.push(runtime);
    const projectFindings: Finding[] = [];
    const makeFinding = (ruleId: string, location: SourceLocation, message: string, source: SourceText | undefined, extras?: ReportExtras): Finding => ({
      ruleId,
      severity: extras?.severity ?? severityOf.get(ruleId) ?? "warning",
      message,
      location,
      related: extras?.related,
      flow: extras?.flow,
      snippet: extras?.snippet ?? source?.lineText(location.startLine).trim(),
    });

    for (const file of project.files) {
      runFileRules(file, index, config, selected, projectFindings, internalErrors, makeFinding);
    }

    const sharedCache = new Map<string, unknown>();
    const sources = new Map<string, SourceText>(project.files.map((f) => [f.relPath, f.source]));
    if (project.yyp) sources.set(project.yyp.relPath, project.yyp.source);
    for (const { rule } of selected) {
      if (!rule.project) continue;
      const ctx: ProjectContext = {
        workspaceRoot: root,
        project,
        index,
        config,
        report: (location, message, extras) => projectFindings.push(makeFinding(rule.meta.id, location, message, sources.get(location.file), extras)),
        locate: (file, span) => locate(file.relPath, file.source, span),
        locateText: (relPath, source, span) => {
          sources.set(relPath, source);
          return locate(relPath, source, span);
        },
        shared: <T>(key: string, compute: () => T): T => {
          if (!sharedCache.has(key)) sharedCache.set(key, compute());
          return sharedCache.get(key) as T;
        },
      };
      try {
        rule.project(ctx);
      } catch (e) {
        internalErrors.push({ ruleId: rule.meta.id, message: errorMessage(e) });
      }
    }

    findings.push(...applySuppressions(projectFindings, project, isIgnored));
  }

  return {
    findings: dedupeAndSort(findings),
    rules: selected.map((s) => s.rule.meta),
    projects,
    filesScanned,
    durationMs: performance.now() - started,
    config,
    internalErrors,
    dependencies,
    runtimes,
  };
}

function runFileRules(
  file: GmlFile,
  index: ProjectIndex,
  config: ResolvedConfig,
  selected: { rule: Rule; severity: Severity }[],
  out: Finding[],
  internalErrors: InternalError[],
  makeFinding: (ruleId: string, location: SourceLocation, message: string, source: SourceText, extras?: ReportExtras) => Finding,
): void {
  const scopes = index.scopes.get(file)!;
  let ancestors: readonly A.Node[] = [];
  const handlers = new Map<string, { ruleId: string; fn: (node: A.Node) => void }[]>();
  const exitHandlers: { ruleId: string; fn: () => void }[] = [];

  for (const { rule } of selected) {
    if (!rule.file) continue;
    const ctx: FileContext = {
      file,
      index,
      scopes,
      config,
      get ancestors() {
        return ancestors;
      },
      enclosingFunction() {
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const a = ancestors[i];
          if (FUNCTION_TYPES.has(a.type)) return a as A.FunctionNode;
        }
        return null;
      },
      report: (span, message, extras) => out.push(makeFinding(rule.meta.id, locate(file.relPath, file.source, span), message, file.source, extras)),
      locate: (span) => locate(file.relPath, file.source, span),
    };
    let visitors;
    try {
      visitors = rule.file(ctx);
    } catch (e) {
      internalErrors.push({ ruleId: rule.meta.id, file: file.relPath, message: errorMessage(e) });
      continue;
    }
    if (!visitors) continue;
    for (const [key, fn] of Object.entries(visitors)) {
      if (!fn) continue;
      if (key === "file:exit") {
        exitHandlers.push({ ruleId: rule.meta.id, fn: fn as () => void });
        continue;
      }
      const list = handlers.get(key) ?? [];
      list.push({ ruleId: rule.meta.id, fn: fn as (node: A.Node) => void });
      handlers.set(key, list);
    }
  }
  if (handlers.size === 0 && exitHandlers.length === 0) return;

  const failed = new Set<string>();
  const call = (ruleId: string, fn: () => void) => {
    if (failed.has(ruleId)) return;
    try {
      fn();
    } catch (e) {
      failed.add(ruleId);
      internalErrors.push({ ruleId, file: file.relPath, message: errorMessage(e) });
    }
  };
  walk(
    file.ast,
    (node, wctx) => {
      ancestors = wctx.ancestors;
      const hs = handlers.get(node.type);
      if (hs) for (const h of hs) call(h.ruleId, () => h.fn(node));
    },
    (node, wctx) => {
      ancestors = wctx.ancestors;
      const hs = handlers.get(`exit:${node.type}`);
      if (hs) for (const h of hs) call(h.ruleId, () => h.fn(node));
    },
  );
  ancestors = [];
  for (const h of exitHandlers) call(h.ruleId, h.fn);
}

export function locate(relPath: string, source: SourceText, span: Span): SourceLocation {
  const s = source.position(span.start);
  const e = source.position(Math.max(span.end, span.start));
  return { file: relPath, startLine: s.line, startColumn: s.column, endLine: e.line, endColumn: e.line === s.line && e.column === s.column ? e.column + 1 : e.column };
}

function applySuppressions(findings: Finding[], project: Project, isIgnored: (p: string) => boolean): Finding[] {
  const byFile = new Map<string, Suppressions>();
  for (const f of project.files) byFile.set(f.relPath, Suppressions.fromComments(f.ast.comments, f.source));
  return findings.filter((f) => !isIgnored(f.location.file) && !byFile.get(f.location.file)?.isSuppressed(f.ruleId, f.location.startLine));
}

export function dedupeAndSort(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const l = f.location;
    const key = `${f.ruleId}|${l.file}|${l.startLine}|${l.startColumn}|${l.endLine}|${l.endColumn}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  const rank: Record<Severity, number> = { error: 0, warning: 1, note: 2 };
  return out.sort(
    (a, b) =>
      a.location.file.localeCompare(b.location.file) ||
      a.location.startLine - b.location.startLine ||
      a.location.startColumn - b.location.startColumn ||
      rank[a.severity] - rank[b.severity] ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack.split("\n").slice(1, 4).join("\n")}` : ""}` : String(e);
}

export { KNOWN_RUNTIMES };
