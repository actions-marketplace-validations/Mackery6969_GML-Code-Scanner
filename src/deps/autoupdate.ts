/**
 * Dependabot-style pull requests for extension updates. For each outdated extension whose
 * release ships a .yymps, it replaces the project's `extensions/<Name>/` folder with the
 * package's copy (keeping the extension's place in the IDE's asset tree) and opens a pull
 * request. Everything goes through the GitHub REST API (Git Data API), so it works with
 * sparse or blobless checkouts and never touches the runner's working tree.
 *
 * Only the extension folder is replaced: per-project option values live in
 * `options/extensions/<Name>.json` and stay as they are, and the package's demo objects,
 * rooms and included files are not imported.
 */
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type * as A from "../parser/ast.ts";
import { walk } from "../parser/walk.ts";
import { tryParseYy, yyArray, yyName } from "../project/yy.ts";
import type { DetectedDependency } from "./detect.ts";
import { describeSource, sourceUrl } from "./registry.ts";
import type { HttpOptions } from "./sources.ts";
import type { DependencyReport } from "./updates.ts";
import { compareVersions } from "./version.ts";
import { Zip } from "./zip.ts";

export const BRANCH_PREFIX = "gml-code-scanner/";

export interface AutoUpdateOptions {
  token: string;
  /** e.g. https://api.github.com */
  apiUrl: string;
  /** e.g. https://github.com, for links in pull request bodies. */
  serverUrl: string;
  /** owner/repo */
  repository: string;
  /** Branch the pull requests target (the default branch). */
  baseBranch: string;
  /** Repository checkout (GITHUB_WORKSPACE). */
  workspaceRoot: string;
  /** Scan root; dependency paths are relative to it. */
  scanRoot: string;
  /** Used for downloading packages. */
  http: HttpOptions;
  log: (message: string) => void;
  /** Most pull requests to open per run (default 5, like Dependabot). */
  maxPullRequests?: number;
  toolUrl?: string;
}

export interface OpenedPullRequest {
  dependency: string;
  from?: string;
  to: string;
  number: number;
  url: string;
}

export interface AutoUpdateResult {
  opened: OpenedPullRequest[];
  skipped: { dependency: string; reason: string }[];
  /** Why GitHub refused to create branches or pull requests (missing permissions), if it did. */
  blocked?: string;
}

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Updates that can become a pull request. */
export function updatableExtensions(reports: DependencyReport[]): DependencyReport[] {
  return reports.filter((r) => {
    const d = r.dependency;
    return (
      r.status === "outdated" &&
      d.kind === "extension" &&
      d.extension &&
      d.spec &&
      d.spec.autoUpdate !== false &&
      d.spec.source.type !== "marketplace" &&
      r.update?.release.packageAsset &&
      !r.update.needsRuntime
    );
  });
}

function api(options: AutoUpdateOptions) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await options.http.fetch(`${options.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gml-code-scanner",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { message?: string }).message ?? "";
      } catch {
        // no JSON body
      }
      throw new GitHubApiError(`${method} ${path} failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`, res.status);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
}

const cleanRef = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "x";

/** Branch names without the version: `gml-code-scanner/[project/]Name-`. */
function branchPrefix(dep: DetectedDependency): string {
  const project = dep.project.rootRel ? `${cleanRef(dep.project.rootRel)}/` : "";
  return `${BRANCH_PREFIX}${project}${cleanRef(dep.extension!.name)}-`;
}

export function branchName(dep: DetectedDependency, version: string): string {
  return branchPrefix(dep) + cleanRef(version);
}

/** A branch name as it appears in a ref URL: each segment encoded, slashes kept. */
const encodeRefPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

const gitBlobSha = (content: Buffer) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

/** A path inside the package that is safe to write below the extension folder. */
function isSafeRelative(p: string): boolean {
  return p !== "" && !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.split("/").some((s) => s === ".." || s === ".") && !/[\0-\x1f\\]/.test(p);
}

export interface PlannedFile {
  /** Path relative to the extension folder. */
  path: string;
  content: Buffer;
}

export interface UpdatePlan {
  files: PlannedFile[];
  /** Functions the installed extension defines that the new version doesn't. */
  removedFunctions: string[];
  /** Package files outside the extension folder (demo objects, rooms, included files). */
  otherPackageFiles: number;
}

/**
 * Picks the extension's files out of a .yymps. The package must contain an extension with
 * the installed one's name; its .yy keeps the installed copy's `parent` (its folder in the
 * IDE's asset tree), so the update doesn't move it.
 */
export function planExtensionUpdate(dep: DetectedDependency, packageBytes: Buffer, installedYy: string | undefined): UpdatePlan {
  const ext = dep.extension!;
  const zip = new Zip(packageBytes);
  const yyName_ = `${ext.name}.yy`;
  const yyEntry = zip.entries.find((e) => {
    const parts = e.name.split("/");
    return parts.length === 3 && parts[0] === "extensions" && parts[2] === yyName_ && parts[1].toLowerCase() === ext.name.toLowerCase();
  });
  if (!yyEntry) throw new Error(`the package has no extension named ${ext.name}`);
  const prefix = yyEntry.name.slice(0, yyEntry.name.lastIndexOf("/") + 1);
  const files: PlannedFile[] = [];
  for (const entry of zip.entries) {
    if (!entry.name.startsWith(prefix) || entry.name.endsWith("/")) continue;
    const rel = entry.name.slice(prefix.length);
    if (!isSafeRelative(rel)) throw new Error(`the package contains an unsafe path: ${entry.name}`);
    let content = zip.read(entry);
    if (entry === yyEntry && installedYy) content = Buffer.from(keepParent(content.toString("utf8"), installedYy), "utf8");
    files.push({ path: rel, content });
  }
  const newYy = tryParseYy(zip.read(yyEntry).toString("utf8"));
  const newFunctions = new Set(yyArray(newYy?.files).flatMap((f) => yyArray((f as Record<string, unknown>).functions).map(yyName)));
  return {
    files,
    removedFunctions: ext.functions.filter((fn) => !newFunctions.has(fn)),
    otherPackageFiles: zip.entries.filter((e) => !e.name.endsWith("/") && !e.name.startsWith(prefix) && e.name !== "metadata.json" && !/\.(yyp|xml)$/.test(e.name)).length,
  };
}

const PARENT = /"parent"\s*:\s*\{[^{}]*\}/;

/** Replaces the new .yy's `"parent": {...}` with the installed one's. */
export function keepParent(newYy: string, installedYy: string): string {
  const old = PARENT.exec(installedYy);
  return old && PARENT.test(newYy) ? newYy.replace(PARENT, () => old[0]) : newYy;
}

/** Calls in the game to the given functions, for the pull request body. */
export function findCalls(dep: DetectedDependency, functions: string[], limit = 20): { fn: string; file: string; line: number }[] {
  const wanted = new Set(functions);
  const out: { fn: string; file: string; line: number }[] = [];
  if (wanted.size === 0) return out;
  for (const file of dep.project.files) {
    if (file.kind === "extension" || ![...wanted].some((fn) => file.source.text.includes(fn))) continue;
    walk(file.ast, (node) => {
      if (out.length >= limit || node.type !== "CallExpression") return;
      const callee = (node as A.CallExpression).callee;
      if (callee.type === "Identifier" && wanted.has(callee.name)) out.push({ fn: callee.name, file: file.relPath, line: file.source.position(node.start).line });
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Release notes in a fence: no @mentions, and no cross-references to upstream issues. */
function fencedNotes(notes: string, max = 6000): string {
  const text = notes.length > max ? `${notes.slice(0, max)}\n…` : notes;
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text.replace(/\r\n/g, "\n")}\n${fence}`;
}

interface PrContext {
  options: AutoUpdateOptions;
  report: DependencyReport;
  plan: UpdatePlan;
  changes: { added: number; changed: number; removed: number };
  /** Files that have content in the project but are empty in the package (filled in at build time). */
  emptied?: string[];
  repoPath: (scanRelative: string) => string;
  branch: string;
}

export function pullRequestBody(ctx: PrContext): string {
  const { report, plan, options } = ctx;
  const d = report.dependency;
  const u = report.update!;
  const spec = d.spec!;
  const ext = d.extension!;
  const lines: string[] = [];
  lines.push(`Bumps the **${ext.name}** extension${d.version ? ` from \`${d.version}\`` : ""} to \`${u.release.version}\`.`, "");
  lines.push("| | |", "|---|---|");
  lines.push(`| Release | [${spec.name} ${u.release.version}](${u.release.url}) from ${describeSource(spec.source)} |`);
  if (u.release.packageAsset) lines.push(`| Package | \`${u.release.packageAsset.name}\` |`);
  const runtime = u.requirement?.minimum
    ? `Needs GameMaker ${u.requirement.minimum} or later (${u.requirement.basis.join("; ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|")}).`
    : "";
  lines.push(`| GameMaker | ${runtime}${report.runtime ? ` This project targets ${report.runtime}.` : ""} |`);
  if (u.updateType) lines.push(`| Update type | ${u.updateType}${u.updateType === "major" ? ": check the release notes for breaking changes" : ""} |`);
  lines.push("");

  lines.push("### What this changes", "");
  const dir = ctx.repoPath(ext.dirRelPath);
  const counts = [ctx.changes.changed && `${ctx.changes.changed} changed`, ctx.changes.added && `${ctx.changes.added} added`, ctx.changes.removed && `${ctx.changes.removed} removed`].filter(Boolean).join(", ");
  lines.push(`Only \`${dir}/\` is replaced, with the extension from the package (${counts} files). The extension stays in the same folder of the asset browser.`);
  lines.push("Extension option values (`options/extensions/`) are left as they are.");
  if (plan.otherPackageFiles) lines.push(`The package's ${plan.otherPackageFiles} other files (demo objects, rooms, fonts, included files) aren't imported.`);
  lines.push("");

  if (ctx.emptied?.length) {
    lines.push("### Files the package leaves empty", "");
    lines.push(
      `These files have content in your project but are empty in the package: ${ctx.emptied.map((f) => `\`${f}\``).join(", ")}. The extension probably fills them in when you build (for example, from an SDK folder set in its extension options), so check its documentation before merging.`,
      "",
    );
  }

  const calls = findCalls(d, plan.removedFunctions);
  if (plan.removedFunctions.length === 0) lines.push("Every function the installed version defines is still there.", "");
  else {
    lines.push("### Functions this version removes", "");
    if (calls.length) {
      lines.push("Your game still calls these, so it won't compile until they're replaced:", "");
      for (const c of calls) {
        const path = ctx.repoPath(c.file);
        lines.push(`- \`${c.fn}\` in [${path}:${c.line}](${options.serverUrl}/${options.repository}/blob/${encodeURIComponent(ctx.branch).replace(/%2F/g, "/")}/${encodeURI(path)}#L${c.line})`);
      }
    } else {
      lines.push(`The new version no longer defines ${plan.removedFunctions.slice(0, 10).map((f) => `\`${f}\``).join(", ")}${plan.removedFunctions.length > 10 ? ` and ${plan.removedFunctions.length - 10} more` : ""}. Your game doesn't call any of them.`);
    }
    lines.push("");
  }

  if (u.release.notes?.trim()) lines.push("<details>", "<summary>Release notes</summary>", "", fencedNotes(u.release.notes.trim()), "", "</details>", "");

  lines.push("---", "");
  const tool = options.toolUrl ? `[GML Code Scanner](${options.toolUrl})` : "GML Code Scanner";
  lines.push(
    `Opened by ${tool}. Close this pull request to skip ${u.release.version}; it won't be opened again. To stop update pull requests, set \`"dependencies": { "autoUpdate": false }\` in \`.gmlscan.json\`, or \`auto-update: false\` in the workflow. Source: ${sourceUrl(spec.source)}`,
  );
  return lines.join("\n") + "\n";
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export async function openUpdatePullRequests(reports: DependencyReport[], options: AutoUpdateOptions): Promise<AutoUpdateResult> {
  const call = api(options);
  const result: AutoUpdateResult = { opened: [], skipped: [] };
  const candidates = updatableExtensions(reports);
  if (candidates.length === 0) return result;
  const repoPath = (p: string) => relative(options.workspaceRoot, join(options.scanRoot, p)).split(sep).join("/");
  const [owner] = options.repository.split("/");
  const max = options.maxPullRequests ?? 5;

  let baseSha: string;
  let baseTree: string;
  try {
    baseSha = (await call<{ object: { sha: string } }>("GET", `/repos/${options.repository}/git/ref/heads/${encodeURIComponent(options.baseBranch)}`)).object.sha;
    baseTree = (await call<{ tree: { sha: string } }>("GET", `/repos/${options.repository}/git/commits/${baseSha}`)).tree.sha;
  } catch (e) {
    result.blocked = e instanceof Error ? e.message : String(e);
    return result;
  }

  /** Files below a directory on the base branch, keyed by path relative to it. */
  const listDir = async (dirPath: string): Promise<Map<string, TreeEntry> | undefined> => {
    let sha = baseTree;
    for (const segment of dirPath.split("/")) {
      const tree = await call<{ tree: TreeEntry[] }>("GET", `/repos/${options.repository}/git/trees/${sha}`);
      const entry = tree.tree.find((t) => t.path === segment && t.type === "tree");
      if (!entry) return undefined;
      sha = entry.sha;
    }
    const tree = await call<{ tree: TreeEntry[]; truncated?: boolean }>("GET", `/repos/${options.repository}/git/trees/${sha}?recursive=1`);
    if (tree.truncated) throw new Error(`the tree of ${dirPath} is too large to list`);
    return new Map(tree.tree.filter((t) => t.type === "blob").map((t) => [t.path, t]));
  };

  for (const report of candidates) {
    const d = report.dependency;
    const u = report.update!;
    const ext = d.extension!;
    const skip = (reason: string) => {
      result.skipped.push({ dependency: d.name, reason });
      options.log(`Not opening an update pull request for ${d.name}: ${reason}.`);
    };
    if (result.opened.length >= max) {
      skip(`already opened ${max} pull requests in this run`);
      continue;
    }
    const branch = branchName(d, u.release.version);
    try {
      const existing = await call<{ number: number; state: string; merged_at: string | null; html_url: string }[]>(
        "GET",
        `/repos/${options.repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      );
      if (existing.length) {
        const pr = existing[0];
        skip(pr.state === "open" ? `#${pr.number} is already open` : pr.merged_at ? `#${pr.number} was already merged` : `#${pr.number} was closed without merging, so this version is skipped`);
        continue;
      }

      const asset = u.release.packageAsset!;
      if (asset.size > MAX_PACKAGE_BYTES) {
        skip(`the package is too large (${Math.round(asset.size / 1024 / 1024)} MB)`);
        continue;
      }
      const res = await options.http.fetch(asset.url, { headers: { "User-Agent": "gml-code-scanner" }, signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`downloading ${asset.name} failed: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());

      const dirPath = repoPath(ext.dirRelPath);
      const existingFiles = await listDir(dirPath);
      if (!existingFiles) {
        skip(`${dirPath} isn't on ${options.baseBranch}`);
        continue;
      }
      const installedYyEntry = existingFiles.get(ext.yyRelPath.slice(ext.dirRelPath.length + 1));
      let installedYy: string | undefined;
      if (installedYyEntry) {
        const blob = await call<{ content: string; encoding: string }>("GET", `/repos/${options.repository}/git/blobs/${installedYyEntry.sha}`);
        installedYy = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8");
      }
      const plan = planExtensionUpdate(d, bytes, installedYy);

      const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
      const changes = { added: 0, changed: 0, removed: 0 };
      const emptied: string[] = [];
      const newPaths = new Set(plan.files.map((f) => f.path));
      for (const f of plan.files) {
        const old = existingFiles.get(f.path);
        if (old && old.sha === gitBlobSha(f.content)) continue;
        if (old && f.content.length === 0 && (old.size ?? 0) > 0) emptied.push(f.path);
        const blob = await call<{ sha: string }>("POST", `/repos/${options.repository}/git/blobs`, { content: f.content.toString("base64"), encoding: "base64" });
        const mode = old?.mode ?? (/\.(sh|command)$/.test(f.path) ? "100755" : "100644");
        entries.push({ path: `${dirPath}/${f.path}`, mode, type: "blob", sha: blob.sha });
        if (old) changes.changed++;
        else changes.added++;
      }
      for (const [path, old] of existingFiles) {
        if (newPaths.has(path)) continue;
        entries.push({ path: `${dirPath}/${path}`, mode: old.mode, type: "blob", sha: null });
        changes.removed++;
      }
      if (entries.length === 0) {
        skip(`${dirPath} already matches ${u.release.version}`);
        continue;
      }

      const title = `Bump ${ext.name} extension${d.version ? ` from ${d.version}` : ""} to ${u.release.version}${d.project.rootRel ? ` in ${d.project.rootRel}` : ""}`;
      const tree = await call<{ sha: string }>("POST", `/repos/${options.repository}/git/trees`, { base_tree: baseTree, tree: entries });
      const commit = await call<{ sha: string }>("POST", `/repos/${options.repository}/git/commits`, {
        message: `deps: ${title.charAt(0).toLowerCase()}${title.slice(1)}\n\nUpdates ${dirPath}/ from ${u.release.url}`,
        tree: tree.sha,
        parents: [baseSha],
      });
      await call("POST", `/repos/${options.repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });

      let pr: { number: number; html_url: string };
      try {
        pr = await call("POST", `/repos/${options.repository}/pulls`, {
          title,
          head: branch,
          base: options.baseBranch,
          body: pullRequestBody({ options, report, plan, changes, emptied, repoPath, branch }),
        });
      } catch (e) {
        await call("DELETE", `/repos/${options.repository}/git/refs/heads/${encodeRefPath(branch)}`).catch(() => undefined);
        throw e;
      }
      await call("POST", `/repos/${options.repository}/issues/${pr.number}/labels`, { labels: ["dependencies"] }).catch(() => undefined);
      result.opened.push({ dependency: d.name, from: d.version, to: u.release.version, number: pr.number, url: pr.html_url });
      options.log(`Opened ${pr.html_url}: ${title}`);

      // Close pull requests for older versions of the same extension, as Dependabot does.
      const prefix = branchPrefix(d);
      const open = await call<{ number: number; head: { ref: string } }[]>("GET", `/repos/${options.repository}/pulls?state=open&per_page=100`);
      for (const old of open) {
        const oldVersion = old.head.ref.startsWith(prefix) ? old.head.ref.slice(prefix.length) : "";
        if (old.number === pr.number || !/^\d/.test(oldVersion) || compareVersions(oldVersion, u.release.version) >= 0) continue;
        await call("POST", `/repos/${options.repository}/issues/${old.number}/comments`, { body: `Superseded by #${pr.number}.` }).catch(() => undefined);
        await call("PATCH", `/repos/${options.repository}/pulls/${old.number}`, { state: "closed" }).catch(() => undefined);
        await call("DELETE", `/repos/${options.repository}/git/refs/heads/${encodeRefPath(old.head.ref)}`).catch(() => undefined);
      }
    } catch (e) {
      if (e instanceof GitHubApiError && (e.status === 403 || e.status === 401)) {
        result.blocked = /not permitted to create or approve pull requests/i.test(e.message)
          ? `GitHub Actions isn't allowed to create pull requests in this repository. Turn on "Allow GitHub Actions to create and approve pull requests" in Settings → Actions → General, or set auto-update: false.`
          : `the workflow's token can't push branches or open pull requests (${e.message}). Give the job \`permissions: contents: write\` and \`pull-requests: write\`, or set auto-update: false.`;
        break;
      }
      skip(e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}
