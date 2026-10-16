/**
 * GitHub Action entry point. Implements the few toolkit features it needs (inputs,
 * outputs, annotations, job summary) directly so the bundle has no dependencies.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { openUpdatePullRequests, updatableExtensions, type AutoUpdateResult } from "./deps/autoupdate.ts";
import { checkUpdates, mergeUpdateFindings, type UpdateCheckResult } from "./deps/updates.ts";
import { ConfigError, type ThreatModel } from "./engine/config.ts";
import { exceedsThreshold, scan } from "./engine/scanner.ts";
import type { Finding, Suite } from "./engine/types.ts";
import { fetchDismissedAlerts, splitDismissed } from "./github/dismissed.ts";
import { fetchPullRequestChanges, inScope, type PrScope } from "./github/pr-scope.ts";
import { UploadError, uploadSarif } from "./github/upload.ts";
import { formatDependencySummary } from "./report/dependencies.ts";
import { formatAnnotations, formatStepSummary } from "./report/github.ts";
import { toSarif } from "./report/sarif.ts";
import { formatText } from "./report/text.ts";
import { loadRuntimeSpec, RuntimeSpecError, type RuntimeSpec } from "./semantic/runtime-spec.ts";
import { REPOSITORY_URL, TOOL_NAME, VERSION } from "./version.ts";

function input(name: string, fallback = ""): string {
  const v = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

const githubToken = () => input("token") || process.env.GITHUB_TOKEN || "";

const githubApiUrl = () => process.env.GITHUB_API_URL ?? "https://api.github.com";

const toPosix = (path: string) => path.split(sep).join("/");

function setOutput(name: string, value: string | number): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function log(message: string): void {
  process.stdout.write(message + "\n");
}

function warn(message: string): void {
  process.stdout.write(`::warning::${escapeData(message)}\n`);
}

function notice(message: string): void {
  process.stdout.write(`::notice::${escapeData(message)}\n`);
}

interface EventPayload {
  pull_request?: { number?: number };
  repository?: { default_branch?: string };
}

function eventPayload(): EventPayload {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EventPayload;
  } catch {
    return {};
  }
}

/** The pull request number when running on a pull_request(_target) event. */
function pullRequestNumber(): number | undefined {
  const n = eventPayload().pull_request?.number;
  return typeof n === "number" ? n : undefined;
}

/** "true" / "false" input, or undefined when unset (so the config file decides). */
function booleanInput(name: string): boolean | undefined {
  const v = input(name);
  return v === "" ? undefined : v === "true";
}

/**
 * The branch update pull requests should target, when this run is on the default branch
 * (push, schedule or manual run), like Dependabot. Never on pull requests.
 */
async function autoUpdateBase(token: string, repository: string): Promise<string | undefined> {
  if (!["push", "schedule", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")) return undefined;
  let branch = eventPayload().repository?.default_branch;
  if (!branch) {
    try {
      const res = await fetch(`${githubApiUrl()}/repos/${repository}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "gml-code-scanner" } });
      if (res.ok) branch = ((await res.json()) as { default_branch?: string }).default_branch;
    } catch {
      // Unknown default branch: don't open pull requests.
    }
  }
  return branch && process.env.GITHUB_REF === `refs/heads/${branch}` ? branch : undefined;
}

function fail(message: string): void {
  process.stdout.write(`::error::${escapeData(message)}\n`);
  process.exitCode = 1;
}

async function run(): Promise<void> {
  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const scanPath = input("path", ".");
  const root = isAbsolute(scanPath) ? scanPath : resolve(workspace, scanPath);
  const failOn = input("fail-on", "error");
  const suite = input("suite") as Suite | "";
  const upload = input("upload", "auto");
  const threatModels = input("threat-models")
    .split(/[\s,]+/)
    .filter(Boolean) as ThreatModel[];
  const sarifFile = resolve(workspace, input("sarif-file", "gml-code-scanner.sarif"));
  const configInput = input("config");
  const category = input("category", "gml-code-scanner");

  if (!["error", "warning", "note", "none"].includes(failOn)) return fail(`Input fail-on must be error, warning, note or none (got "${failOn}")`);
  if (suite && !["default", "security-extended", "security-and-quality", "all"].includes(suite)) return fail(`Input suite must be default, security-extended, security-and-quality or all (got "${suite}")`);
  if (threatModels.some((t) => t !== "remote" && t !== "local")) return fail(`Input threat-models may only contain remote and local`);
  if (!["auto", "true", "false", "always", "never"].includes(upload)) return fail(`Input upload must be auto, true or false (got "${upload}")`);
  const prScope = input("pr-scope", "changed-lines") as PrScope;
  if (!["changed-lines", "changed-files", "all"].includes(prScope)) return fail(`Input pr-scope must be changed-lines, changed-files or all (got "${prScope}")`);
  for (const name of ["check-updates", "runtime-updates", "auto-update"]) {
    if (!["", "true", "false"].includes(input(name))) return fail(`Input ${name} must be true or false (got "${input(name)}")`);
  }

  log(`${TOOL_NAME} ${VERSION}: scanning ${relative(workspace, root) || "."}`);

  // An installed runtime (such as bscotch/igor-setup's runtime-dir output) gives exact availability checks.
  let runtimeSpec: RuntimeSpec | undefined;
  const runtimeDir = input("runtime-dir");
  if (runtimeDir) {
    try {
      runtimeSpec = loadRuntimeSpec(resolve(workspace, runtimeDir));
      log(`Checking against GameMaker runtime ${runtimeSpec.version} (${runtimeSpec.functions.size} functions) from ${toPosix(relative(workspace, runtimeSpec.dir)) || "."}.`);
    } catch (e) {
      if (!(e instanceof RuntimeSpecError)) throw e;
      warn(`${e.message} Using the bundled runtime data instead.`);
    }
  }

  let result;
  try {
    result = scan({
      root,
      configPath: configInput ? resolve(workspace, configInput) : undefined,
      suite: suite || undefined,
      runtime: input("runtime") || undefined,
      runtimeSpec,
      threatModels: threatModels.length ? threatModels : undefined,
    });
  } catch (e) {
    if (e instanceof ConfigError) return fail(e.message);
    throw e;
  }
  if (runtimeSpec && result.projects.length > 0 && !result.projects.some((p) => p.runtimeData === runtimeSpec?.version)) {
    const line = runtimeSpec.version.split(".").slice(0, 2).join(".");
    warn(`No project targets the ${line} release line, so the runtime in runtime-dir (${runtimeSpec.version}) wasn't used. Set runtime: ${runtimeSpec.version} to check against it anyway.`);
  }
  if (result.projects.length === 0) warn(`No GameMaker project (.yyp) or .gml files found under ${relative(workspace, root) || "."}. Set the "path" input to your project folder.`);

  // Dependency updates need the network, so they're checked after the (offline) scan.
  const dependencies = result.config.dependencies;
  const runtimeUpdates = booleanInput("runtime-updates") ?? dependencies.runtimeUpdates;
  let updates: UpdateCheckResult | undefined;
  if ((booleanInput("check-updates") ?? dependencies.checkUpdates ?? true) && (result.dependencies.length > 0 || (runtimeUpdates && result.runtimes.length > 0))) {
    try {
      // The workflow token belongs to this GitHub instance; release lookups go to github.com.
      const releaseToken = githubApiUrl() === "https://api.github.com" ? githubToken() || undefined : undefined;
      updates = await checkUpdates(result, { http: { fetch, githubToken: releaseToken }, runtimeUpdates });
      mergeUpdateFindings(result, updates);
      for (const e of updates.errors) warn(`Couldn't check for updates of ${e}`);
    } catch (e) {
      warn(`The dependency update check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const toRepoPath = (file: string) => toPosix(relative(workspace, join(root, file)));

  // File names and code from the scanned repo are printed below; pause workflow-command
  // processing so a file named "::error::..." can't inject annotations or commands.
  const resumeToken = randomUUID().replace(/-/g, "");
  log(`::group::Findings (${result.findings.length})`);
  log(`::stop-commands::${resumeToken}`);
  process.stdout.write(formatText(result, { color: true, showPaths: true, updates }));
  log(`::${resumeToken}::`);
  log("::endgroup::");

  const sarif = toSarif(result, {
    toolName: TOOL_NAME,
    toolVersion: VERSION,
    informationUri: REPOSITORY_URL,
    scanRoot: root,
    uriBase: workspace,
    category,
  });
  mkdirSync(dirname(sarifFile), { recursive: true });
  writeFileSync(sarifFile, JSON.stringify(sarif, null, 2));
  log(`SARIF written to ${relative(workspace, sarifFile)}`);

  // On pull requests, report only what the pull request changed; the SARIF keeps everything.
  let reported = result.findings;
  let scoped = false;
  const scopeNote = () =>
    `Showing ${reported.length} finding${reported.length === 1 ? "" : "s"} on ${prScope === "changed-lines" ? "lines" : "files"} changed by this pull request. The whole project has ${result.findings.length}; all of them are in the SARIF file.`;
  const pull = pullRequestNumber();
  if (pull !== undefined && prScope !== "all") {
    try {
      const changes = await fetchPullRequestChanges({
        token: githubToken(),
        apiUrl: githubApiUrl(),
        repository: process.env.GITHUB_REPOSITORY ?? "",
        pull,
      });
      reported = result.findings.filter((f) => inScope(f, changes, toRepoPath, prScope));
      scoped = true;
      log(scopeNote());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`Could not limit results to this pull request's changes (${msg.replace(/.$/, "")}). Reporting all findings instead.`);
    }
  }

  // Upload to code scanning, like CodeQL's analyze step.
  let uploadNote = "";
  let dismissedNote = "";
  let dismissedCount = 0;
  let dismissedFindings: Finding[] = [];
  if (upload !== "false" && upload !== "never") {
    const token = githubToken();
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    const ref = process.env.GITHUB_REF;
    const required = upload === "true" || upload === "always";
    let processed = false;
    if (!token || !repository || !sha || !ref) {
      const msg = "Skipping the code scanning upload: not running in GitHub Actions (or no token).";
      if (required) fail(msg);
      else log(msg);
    } else {
      try {
        const res = await uploadSarif(sarif, {
          token,
          apiUrl: githubApiUrl(),
          repository,
          sha,
          ref,
          checkoutUri: pathToFileURL(workspace).href,
          toolName: TOOL_NAME,
          waitForProcessing: input("wait-for-processing", "true") === "true",
          log,
        });
        setOutput("sarif-id", res.id);
        if (res.status === "failed") warn(`Code scanning could not process the results: ${res.errors.join("; ")}`);
        else if (res.status === "complete") {
          log("Code scanning processed the results.");
          uploadNote = `Results are in the repository's **Security → Code scanning** tab.`;
          processed = true;
        } else if (reported.length) {
          log("Code scanning hasn't processed the results yet, so findings with dismissed alerts are reported too.");
        }
      } catch (e) {
        const err = e instanceof UploadError ? e : new UploadError(String(e), 0, false);
        const hint = err.unavailable
          ? " Findings are still shown as annotations and in the job summary. To see them in the Security tab, give the workflow `permissions: security-events: write` and make sure code scanning is available (public repositories, or private ones with GitHub Code Security). Pull requests from forks can't upload; set upload: false to silence this."
          : "";
        if (required) fail(err.message + hint);
        // In auto mode, "code scanning isn't available here" (private repo without Code
        // Security, fork PR) is an expected outcome, not a problem with the run.
        else if (err.unavailable) notice(`Code scanning isn't available for this run, so results are shown as annotations and in the job summary instead (${err.message.replace(/^GitHub rejected the SARIF upload /, "")}). Set upload: false to skip the upload.`);
        else warn(err.message + hint);
      }

      // A dismissed alert stays dismissed until its line changes, so don't annotate or fail on it either.
      if (processed && reported.length) {
        try {
          const alerts = await fetchDismissedAlerts({ token, apiUrl: githubApiUrl(), repository, ref, sha, toolName: TOOL_NAME, category });
          const { open, dismissed } = splitDismissed(reported, alerts, toRepoPath);
          if (dismissed.length) {
            reported = open;
            dismissedFindings = dismissed;
            dismissedCount = dismissed.length;
            dismissedNote = dismissed.length === 1 ? "Left out 1 finding whose alert is dismissed in code scanning." : `Left out ${dismissed.length} findings whose alerts are dismissed in code scanning.`;
            log(dismissedNote);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn(`${msg} Findings with dismissed alerts are reported too.`);
        }
      }
    }
  }

  if (input("annotations", "true") === "true") {
    const max = Number(input("max-annotations", "50")) || 50;
    const annotations = formatAnnotations(reported, toRepoPath, max);
    if (annotations) log(annotations);
  }

  // Dependabot-style pull requests for extension updates.
  let autoUpdate: AutoUpdateResult | undefined;
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (updates && (booleanInput("auto-update") ?? dependencies.autoUpdate)) {
    // An update whose alert was dismissed in code scanning doesn't get a pull request either.
    const dismissedAt = new Set(dismissedFindings.filter((f) => f.ruleId === "gml/outdated-dependency").map((f) => `${f.location.file}:${f.location.startLine}`));
    const wanted = updates.reports.filter((r) => !dismissedAt.has(`${r.dependency.location.file}:${r.dependency.location.startLine}`));
    const token = githubToken();
    if (updatableExtensions(wanted).length && token && repository) {
      const base = await autoUpdateBase(token, repository);
      if (base) {
        autoUpdate = await openUpdatePullRequests(wanted, {
          token,
          apiUrl: githubApiUrl(),
          serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
          repository,
          baseBranch: base,
          workspaceRoot: workspace,
          scanRoot: root,
          http: { fetch },
          log,
          toolUrl: REPOSITORY_URL,
        });
        if (autoUpdate.blocked) notice(`Extension updates are available, but no pull requests were opened: ${autoUpdate.blocked}`);
      }
    }
  }

  if (input("step-summary", "true") === "true" && process.env.GITHUB_STEP_SUMMARY) {
    let summary = formatStepSummary({ ...result, findings: reported }, toRepoPath, { serverUrl: process.env.GITHUB_SERVER_URL, repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA });
    const notes = [scoped ? scopeNote() : "", dismissedNote].filter(Boolean);
    if (notes.length) summary = summary.replace("## GML Code Scanner\n\n", `## GML Code Scanner\n\n${notes.map((n) => `> ${n}`).join("\n>\n")}\n\n`);
    if (updates) {
      const deps = formatDependencySummary(updates, autoUpdate);
      if (deps) summary += `\n${deps}`;
    }
    if (uploadNote) summary += `\n${uploadNote}\n`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  const counts = { error: 0, warning: 0, note: 0 };
  for (const f of reported) counts[f.severity]++;
  setOutput("sarif-file", toPosix(relative(workspace, sarifFile)));
  setOutput("findings", reported.length);
  setOutput("total-findings", result.findings.length);
  setOutput("dismissed", dismissedCount);
  setOutput("errors", counts.error);
  setOutput("warnings", counts.warning);
  setOutput("notes", counts.note);
  setOutput("outdated-dependencies", updates?.reports.filter((r) => r.status === "outdated").length ?? 0);
  setOutput("update-pull-requests", autoUpdate?.opened.map((p) => p.url).join(" ") ?? "");

  if (exceedsThreshold({ ...result, findings: reported }, failOn)) {
    fail(`GML Code Scanner found problems at or above "${failOn}" severity (${counts.error} errors, ${counts.warning} warnings, ${counts.note} notes). Set fail-on: none to report without failing.`);
  }
}

run().catch((e) => fail(`GML Code Scanner crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
