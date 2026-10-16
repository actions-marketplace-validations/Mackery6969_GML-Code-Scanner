/**
 * Finds a project's dependencies: extensions (with their `extensionVersion`), libraries
 * copied into scripts (recognised by a `#macro NAME_VERSION "x.y.z"`), and generated
 * scripts such as GMLive's that record when they were built.
 */
import { join } from "node:path";
import type * as A from "../parser/ast.ts";
import { walk } from "../parser/walk.ts";
import { readText, type Project } from "../project/loader.ts";
import { SourceText } from "../project/source.ts";
import { tryParseYy, yyArray, yyName } from "../project/yy.ts";
import type { SourceLocation } from "../engine/types.ts";
import type { DependencySpec } from "./registry.ts";

export type DependencyKind = "extension" | "library" | "generated";

export interface InstalledExtension {
  /** Resource name, which is also its folder name. */
  name: string;
  /** Workspace-relative path of the extension's .yy. */
  yyRelPath: string;
  /** Workspace-relative extension folder. */
  dirRelPath: string;
  functions: string[];
  /** File names listed in the .yy (DLLs, .ext, .gml). */
  files: string[];
}

export interface DetectedDependency {
  kind: DependencyKind;
  /** The registry entry it matched; undefined for extensions the scanner doesn't know. */
  spec?: DependencySpec;
  /** Display name. */
  name: string;
  /** Version recorded in the project, if any. */
  version?: string;
  /** For generated scripts: the date (YYYY-MM-DD) the installed copy was generated. */
  generatedAt?: string;
  /** Oldest GameMaker version the installed copy says it supports ("for v2.3.7+"). */
  requires?: string;
  /** Where the version is declared; findings point here. */
  location: SourceLocation;
  /** Text of that line (for stable SARIF fingerprints). */
  snippet: string;
  project: Project;
  extension?: InstalledExtension;
}

export interface RuntimeTarget {
  project: Project;
  /** GameMaker version the project targets. */
  version: string;
  /** Set with `runtime` (config or command line) rather than read from the .yyp's IDEVersion. */
  explicit: boolean;
  /** The .yyp's IDEVersion, where runtime update findings point. */
  location?: SourceLocation;
  snippet?: string;
}

const VERSION_MACRO = /^_*([A-Z][A-Z0-9_]*?)_VERSION$/;
const GENERATED_HEADER = /^\/\/\s*Generated at (\d{4}-\d{2}-\d{2})(?:[^\n]*?\bfor v(\d+(?:\.\d+)+)\+)?[^\n]*$/m;

function locateSpan(file: string, source: SourceText, start: number, end: number): SourceLocation {
  const s = source.position(start);
  const e = source.position(end);
  return { file, startLine: s.line, startColumn: s.column, endLine: e.line, endColumn: e.column };
}

const lower = (s: string) => s.toLowerCase();

function matchesName(spec: DependencySpec, name: string): boolean {
  return spec.extensions?.some((n) => lower(n) === lower(name)) ?? false;
}

/** The GameMaker version a project targets: the configured runtime, else the .yyp's IDEVersion. */
export function detectRuntime(project: Project, configured?: string): RuntimeTarget | undefined {
  const yyp = project.yyp;
  const version = configured ?? yyp?.ideVersion;
  if (!version) return undefined;
  const target: RuntimeTarget = { project, version, explicit: configured !== undefined };
  const m = yyp ? /"IDEVersion"\s*:\s*"([^"]*)"/.exec(yyp.source.text) : null;
  if (yyp && m) {
    const start = m.index + m[0].length - m[1].length - 1;
    target.location = locateSpan(yyp.relPath, yyp.source, start, start + m[1].length + 2);
    target.snippet = yyp.source.lineText(target.location.startLine).trim();
  }
  return target;
}

/** All dependencies of one project. `specs` is checked in order, so earlier entries (the config's) win. */
export function detectDependencies(project: Project, specs: DependencySpec[]): DetectedDependency[] {
  const out: DetectedDependency[] = [];
  out.push(...detectExtensions(project, specs));
  out.push(...detectLibraries(project, specs));
  out.push(...detectGenerated(project, specs));
  return out;
}

function detectExtensions(project: Project, specs: DependencySpec[]): DetectedDependency[] {
  const out: DetectedDependency[] = [];
  const seen = new Set<string>();
  for (const [, list] of project.resources) {
    for (const r of list) {
      if (r.type !== "extensions" || !r.onDisk || seen.has(r.yyRelPath)) continue;
      seen.add(r.yyRelPath);
      const text = readText(join(project.rootAbs, r.yyRelPath.slice(project.rootRel ? project.rootRel.length + 1 : 0)));
      if (text === undefined) continue;
      const yy = tryParseYy(text);
      if (!yy) continue;
      const functions: string[] = [];
      const files: string[] = [];
      for (const f of yyArray(yy.files)) {
        const file = f as Record<string, unknown>;
        if (typeof file.filename === "string" && file.filename) files.push(file.filename);
        for (const fn of yyArray(file.functions)) {
          const n = yyName(fn);
          if (n) functions.push(n);
        }
      }
      const extension: InstalledExtension = {
        name: r.name,
        yyRelPath: r.yyRelPath,
        dirRelPath: r.yyRelPath.slice(0, r.yyRelPath.lastIndexOf("/")),
        functions,
        files,
      };
      const fnSet = new Set(functions);
      const spec = specs.find((s) => matchesName(s, r.name) && (!s.functions?.length || s.functions.some((fn) => fnSet.has(fn))));

      const source = new SourceText(text);
      const m = /"extensionVersion"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      const start = m ? m.index + m[0].length - m[1].length - 1 : 0;
      const end = m ? start + m[1].length + 2 : 1;
      const location = locateSpan(r.yyRelPath, source, start, end);
      out.push({
        kind: "extension",
        spec,
        name: spec?.name ?? r.name,
        version: m?.[1] || undefined,
        location,
        snippet: source.lineText(location.startLine).trim(),
        project,
        extension,
      });
    }
  }
  return out;
}

function detectLibraries(project: Project, specs: DependencySpec[]): DetectedDependency[] {
  const out = new Map<DependencySpec, DetectedDependency>();
  for (const file of project.files) {
    if (file.kind !== "script" || !file.source.text.includes("_VERSION")) continue;
    walk(file.ast, (node) => {
      if (node.type !== "MacroDeclaration") return;
      const macro = node as A.MacroDeclaration;
      const stem = VERSION_MACRO.exec(macro.id.name)?.[1];
      if (!stem || macro.config) return;
      const spec = specs.find((s) => s.macros?.includes(stem));
      if (!spec || out.has(spec)) return;
      const value = macro.value;
      if (!value || value.type !== "StringLiteral") return;
      const location = locateSpan(file.relPath, file.source, value.start, value.end);
      out.set(spec, {
        kind: "library",
        spec,
        name: spec.name,
        version: value.value,
        location,
        snippet: file.source.lineText(location.startLine).trim(),
        project,
      });
    });
  }
  return [...out.values()];
}

function detectGenerated(project: Project, specs: DependencySpec[]): DetectedDependency[] {
  const out: DetectedDependency[] = [];
  for (const spec of specs) {
    if (!spec.generatedScript) continue;
    const file = project.files.find((f) => f.kind === "script" && f.resource === spec.generatedScript && f.relPath.endsWith(`/${spec.generatedScript}.gml`));
    if (!file) continue;
    const head = file.source.text.slice(0, 2000);
    const m = GENERATED_HEADER.exec(head);
    const location = m
      ? locateSpan(file.relPath, file.source, m.index, m.index + m[0].length)
      : { file: file.relPath, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
    out.push({
      kind: "generated",
      spec,
      name: spec.name,
      generatedAt: m?.[1],
      requires: m?.[2],
      location,
      snippet: file.source.lineText(location.startLine).trim(),
      project,
    });
  }
  return out;
}
