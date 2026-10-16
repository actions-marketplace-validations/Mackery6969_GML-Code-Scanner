import type * as A from "../parser/ast.ts";
import type { GmlFile, Project } from "../project/loader.ts";
import type { SourceText } from "../project/source.ts";
import type { ProjectIndex } from "../semantic/project-index.ts";
import type { FileScopes } from "../semantic/scope.ts";
import type { ResolvedConfig } from "./config.ts";

export type Severity = "error" | "warning" | "note";
export type Category = "security" | "correctness" | "performance" | "maintainability" | "project" | "dependencies";

/**
 * Which query suite a rule first appears in (mirrors CodeQL's suites):
 * - `default`: high-precision problems, on by default
 * - `extended`: extra security rules with lower precision (`security-extended`)
 * - `quality`: code-quality and style suggestions (`security-and-quality`)
 */
export type RuleTier = "default" | "extended" | "quality";
export type Suite = "default" | "security-extended" | "security-and-quality" | "all";

export interface RuleMeta {
  /** Stable id, e.g. `gml/undefined-function`. Never rename: it keys alerts on GitHub. */
  id: string;
  /** PascalCase display name for SARIF. */
  name: string;
  category: Category;
  severity: Severity;
  precision: "very-high" | "high" | "medium" | "low";
  tier: RuleTier;
  /** CVSS-like 0.0-10.0 score for security rules (GitHub maps it to critical/high/medium/low). */
  securitySeverity?: number;
  cwe?: number[];
  /** `path-problem` results carry a source → sink data-flow path. */
  kind?: "problem" | "path-problem";
  /** One sentence. */
  short: string;
  /** A short paragraph. */
  full: string;
  /** Markdown help: why it matters, how to fix, examples. Shown on GitHub and used by Copilot Autofix. */
  help: string;
}

export interface SourceLocation {
  /** Workspace-relative path with forward slashes. */
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface FlowStep {
  location: SourceLocation;
  message: string;
}

export interface RelatedLocation {
  location: SourceLocation;
  message: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  location: SourceLocation;
  related?: RelatedLocation[];
  /** Data-flow path from source to sink (path-problem rules). */
  flow?: FlowStep[];
  /** Text of the primary line, for fingerprints and console output. */
  snippet?: string;
}

export interface ReportExtras {
  related?: RelatedLocation[];
  flow?: FlowStep[];
  severity?: Severity;
  /** Replaces the source line shown in reports (e.g. with a secret redacted). */
  snippet?: string;
}

export interface Span {
  start: number;
  end: number;
}

type NodeOfType<K extends A.Node["type"]> = Extract<A.Node, { type: K }>;

/** Visitor callbacks keyed by node type; `exit:<Type>` runs after the node's children. */
export type Visitors = {
  [K in A.Node["type"]]?: (node: NodeOfType<K>) => void;
} & {
  [K in A.Node["type"] as `exit:${K}`]?: (node: NodeOfType<K>) => void;
} & {
  /** Runs once after the whole file has been walked. */
  "file:exit"?: () => void;
};

export interface FileContext {
  readonly file: GmlFile;
  readonly index: ProjectIndex;
  readonly scopes: FileScopes;
  readonly config: ResolvedConfig;
  /** Ancestors of the node currently being visited, outermost first. */
  readonly ancestors: readonly A.Node[];
  /** Innermost enclosing function of the current node, or null at file level. */
  enclosingFunction(): A.FunctionNode | null;
  report(node: Span, message: string, extras?: ReportExtras): void;
  locate(node: Span): SourceLocation;
}

export interface ProjectContext {
  /** Absolute path of the scanned root; workspace-relative paths resolve against it. */
  readonly workspaceRoot: string;
  readonly project: Project;
  readonly index: ProjectIndex;
  readonly config: ResolvedConfig;
  report(location: SourceLocation, message: string, extras?: ReportExtras): void;
  locate(file: GmlFile, node: Span): SourceLocation;
  locateText(relPath: string, source: SourceText, span: Span): SourceLocation;
  /** Shared, memoized analyses (e.g. taint tracking) used by several rules. */
  shared<T>(key: string, compute: () => T): T;
}

export interface Rule {
  meta: RuleMeta;
  /** Called once per GML file; returns visitors for the shared AST walk. */
  file?(ctx: FileContext): Visitors | void;
  /** Called once per project after file rules. */
  project?(ctx: ProjectContext): void;
}
