import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DependencySource, DependencySpec } from "../deps/registry.ts";
import type { UpdateType } from "../deps/version.ts";
import { stripTrailingCommas } from "../project/yy.ts";
import { compileIgnoreLines, ignorePatternToRegExp, matcherFor } from "./ignore.ts";
import type { Severity, Suite } from "./types.ts";

export type ThreatModel = "remote" | "local";

export type RuleSetting = "off" | Severity | { severity?: "off" | Severity };

export interface TaintSourceModel {
  /** Function whose return value is untrusted. */
  function: string;
  kind?: ThreatModel;
  description?: string;
}

export interface TaintSinkModel {
  function: string;
  /** Zero-based argument indices that must not receive untrusted data. */
  arguments: number[];
  /** Which rule reports it: code-injection, path-injection, command-injection, url-redirect, variable-injection, unsafe-deserialization. */
  kind: string;
}

export interface PatternRuleConfig {
  id: string;
  /** GML snippet with `$METAVARS` and `...` wildcards. A list means "any of". */
  pattern: string | string[];
  message: string;
  severity?: Severity;
  /** Only match in these object events (e.g. ["Step", "Draw"]) */
  events?: string[];
  /** Regex constraints on metavariable source text: { "$X": "^obj_" } */
  where?: Record<string, string>;
  help?: string;
  category?: "security" | "correctness" | "performance" | "maintainability";
}

export interface Config {
  $schema?: string;
  suite?: Suite;
  rules?: Record<string, RuleSetting>;
  /** Glob patterns (workspace-relative) whose findings are dropped; project files there are still indexed. */
  ignore?: string[];
  /** Target GameMaker runtime (e.g. "2023.1.1.81"); defaults to the .yyp IDEVersion. */
  runtime?: string;
  /** Untrusted data sources to consider: remote (network/HTTP) and/or local (files, user input). */
  threatModels?: ThreatModel[];
  /** Variables starting with these prefixes are treated as declared globals (like Stitch's autoDeclareGlobalsPrefixes). */
  globalPrefixes?: string[];
  taint?: {
    sources?: TaintSourceModel[];
    sinks?: TaintSinkModel[];
    /** Functions whose return value is always safe. */
    sanitizers?: string[];
  };
  patterns?: PatternRuleConfig[];
  dependencies?: DependenciesConfig;
}

export interface DependencyIgnore {
  /** Dependency name (as reported), extension name or version-macro stem; case-insensitive. */
  name: string;
  /** Only ignore these versions: "3.x", "2.1.*" or exact versions. */
  versions?: string[];
  /** Only ignore these kinds of update. */
  updateTypes?: UpdateType[];
}

/** A project-specific dependency source, in the friendlier shape used by .gmlscan.json. */
export interface DependencySourceConfig {
  name: string;
  /** Extension resource name. */
  extension?: string;
  /** Version macro stem: "MYLIB" for `#macro MYLIB_VERSION "1.2.3"`. */
  macro?: string;
  github?: string;
  codeberg?: string;
  marketplace?: number;
  /** Regular expression for the release asset; a capture group gives the version. */
  asset?: string;
  autoUpdate?: boolean;
}

export interface DependenciesConfig {
  /** Look for newer versions of extensions and libraries (needs network access). */
  checkUpdates?: boolean;
  /** Also report newer GameMaker runtimes, and dependency updates that need one. */
  runtimeUpdates?: boolean;
  /** Open pull requests that update extensions (GitHub Action, on the default branch). */
  autoUpdate?: boolean;
  ignore?: (string | DependencyIgnore)[];
  sources?: DependencySourceConfig[];
}

export interface ResolvedDependenciesConfig {
  /** Undefined when the config doesn't say; the CLI and the action pick their own default. */
  checkUpdates?: boolean;
  runtimeUpdates: boolean;
  autoUpdate: boolean;
  ignore: DependencyIgnore[];
  sources: DependencySpec[];
}

export interface ResolvedConfig {
  suite: Suite;
  rules: Record<string, RuleSetting>;
  ignore: string[];
  runtime?: string;
  threatModels: ThreatModel[];
  globalPrefixes: string[];
  taint: { sources: TaintSourceModel[]; sinks: TaintSinkModel[]; sanitizers: string[] };
  patterns: PatternRuleConfig[];
  dependencies: ResolvedDependenciesConfig;
  /** Path the config was loaded from, if any. */
  path?: string;
}

export const CONFIG_FILE_NAMES = [".gmlscan.json", "gmlscan.json", ".github/gmlscan.json"];

export function defaultConfig(): ResolvedConfig {
  return {
    suite: "default",
    rules: {},
    ignore: [],
    threatModels: ["remote"],
    globalPrefixes: [],
    taint: { sources: [], sinks: [], sanitizers: [] },
    patterns: [],
    dependencies: { runtimeUpdates: false, autoUpdate: true, ignore: [], sources: [] },
  };
}

/** JSON with `//` and `/* *\/` comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(stripTrailingCommas(out));
}

export class ConfigError extends Error {}

export function loadConfig(root: string, explicitPath?: string): ResolvedConfig {
  const candidates = explicitPath ? [explicitPath] : CONFIG_FILE_NAMES.map((n) => join(root, n));
  for (const path of candidates) {
    if (!existsSync(path)) {
      if (explicitPath) throw new ConfigError(`Config file not found: ${path}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = parseJsonc(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ConfigError(`Invalid JSON in ${path}: ${(e as Error).message}`);
    }
    return { ...resolveConfig(validate(raw, path)), path };
  }
  return defaultConfig();
}

const SUITES: Suite[] = ["default", "security-extended", "security-and-quality", "all"];

function validate(raw: unknown, path: string): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${path}: expected a JSON object`);
  const c = raw as Config;
  if (c.suite !== undefined && !SUITES.includes(c.suite)) throw new ConfigError(`${path}: "suite" must be one of ${SUITES.join(", ")}`);
  if (c.threatModels !== undefined && (!Array.isArray(c.threatModels) || c.threatModels.some((t) => t !== "remote" && t !== "local"))) {
    throw new ConfigError(`${path}: "threatModels" must be an array of "remote" / "local"`);
  }
  for (const [id, setting] of Object.entries(c.rules ?? {})) {
    const sev = typeof setting === "string" ? setting : setting?.severity;
    if (sev !== undefined && !["off", "error", "warning", "note"].includes(sev)) {
      throw new ConfigError(`${path}: rules["${id}"] must be "off", "error", "warning" or "note"`);
    }
  }
  for (const p of c.patterns ?? []) {
    if (!p.id || !p.pattern || !p.message) throw new ConfigError(`${path}: each pattern rule needs "id", "pattern" and "message"`);
  }
  validateDependencies(c.dependencies, path);
  return c;
}

const UPDATE_TYPES = ["major", "minor", "patch"];

function validateDependencies(d: DependenciesConfig | undefined, path: string): void {
  if (d === undefined) return;
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new ConfigError(`${path}: "dependencies" must be an object`);
  for (const key of ["checkUpdates", "runtimeUpdates", "autoUpdate"] as const) {
    if (d[key] !== undefined && typeof d[key] !== "boolean") throw new ConfigError(`${path}: dependencies.${key} must be true or false`);
  }
  for (const i of d.ignore ?? []) {
    if (typeof i === "string") continue;
    if (!i || typeof i.name !== "string") throw new ConfigError(`${path}: each dependencies.ignore entry needs a "name"`);
    if (i.updateTypes?.some((t) => !UPDATE_TYPES.includes(t))) throw new ConfigError(`${path}: dependencies.ignore updateTypes may only contain major, minor and patch`);
  }
  for (const s of d.sources ?? []) {
    if (!s || typeof s.name !== "string") throw new ConfigError(`${path}: each dependencies.sources entry needs a "name"`);
    if (!s.extension && !s.macro) throw new ConfigError(`${path}: dependencies.sources "${s.name}" needs "extension" or "macro" to recognise it`);
    const where = [s.github, s.codeberg, s.marketplace].filter((v) => v !== undefined);
    if (where.length !== 1) throw new ConfigError(`${path}: dependencies.sources "${s.name}" needs exactly one of "github", "codeberg" or "marketplace"`);
    if ((s.github ?? s.codeberg) !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(s.github ?? s.codeberg ?? "")) {
      throw new ConfigError(`${path}: dependencies.sources "${s.name}": repositories are written owner/name`);
    }
    if (s.marketplace !== undefined && !Number.isInteger(s.marketplace)) throw new ConfigError(`${path}: dependencies.sources "${s.name}": "marketplace" is the asset's number`);
    if (s.asset !== undefined) {
      try {
        new RegExp(s.asset);
      } catch (e) {
        throw new ConfigError(`${path}: dependencies.sources "${s.name}": invalid "asset" pattern: ${(e as Error).message}`);
      }
    }
  }
}

function resolveDependencySource(s: DependencySourceConfig): DependencySpec {
  const source: DependencySource = s.github ? { type: "github", repo: s.github } : s.codeberg ? { type: "codeberg", repo: s.codeberg } : { type: "marketplace", id: s.marketplace! };
  return {
    name: s.name,
    ...(s.extension ? { extensions: [s.extension] } : {}),
    ...(s.macro ? { macros: [s.macro.replace(/^_+/, "").replace(/_VERSION$/, "")] } : {}),
    source,
    ...(s.asset ? { asset: s.asset } : {}),
    ...(s.autoUpdate !== undefined ? { autoUpdate: s.autoUpdate } : {}),
  };
}

export function resolveConfig(c: Config): ResolvedConfig {
  const d = defaultConfig();
  return {
    suite: c.suite ?? d.suite,
    rules: c.rules ?? {},
    ignore: c.ignore ?? [],
    runtime: c.runtime,
    threatModels: c.threatModels ?? d.threatModels,
    globalPrefixes: c.globalPrefixes ?? [],
    taint: {
      sources: c.taint?.sources ?? [],
      sinks: c.taint?.sinks ?? [],
      sanitizers: c.taint?.sanitizers ?? [],
    },
    patterns: c.patterns ?? [],
    dependencies: {
      checkUpdates: c.dependencies?.checkUpdates,
      runtimeUpdates: c.dependencies?.runtimeUpdates ?? d.dependencies.runtimeUpdates,
      autoUpdate: c.dependencies?.autoUpdate ?? d.dependencies.autoUpdate,
      ignore: (c.dependencies?.ignore ?? []).map((i) => (typeof i === "string" ? { name: i } : i)),
      sources: (c.dependencies?.sources ?? []).map(resolveDependencySource),
    },
  };
}

export function globToRegExp(glob: string): RegExp {
  return ignorePatternToRegExp(glob.replace(/\/+$/, ""), /.\/+$/.test(glob));
}

export function makeIgnoreMatcher(globs: string[]): (relPath: string) => boolean {
  return matcherFor(compileIgnoreLines(globs));
}
