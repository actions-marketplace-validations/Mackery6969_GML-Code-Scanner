/**
 * GitHub Action entry point. Implements the few toolkit features it needs (inputs,
 * outputs, annotations, job summary) directly so the bundle has no dependencies.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, type ThreatModel } from "./engine/config.ts";
import { exceedsThreshold, scan } from "./engine/scanner.ts";
import type { Suite } from "./engine/types.ts";
import { fetchPullRequestChanges, inScope, type PrScope } from "./github/pr-scope.ts";
import { UploadError, uploadSarif } from "./github/upload.ts";
import { formatAnnotations, formatStepSummary } from "./report/github.ts";
import { toSarif } from "./report/sarif.ts";
import { formatText } from "./report/text.ts";
import { REPOSITORY_URL, TOOL_NAME, VERSION } from "./version.ts";

function input(name: string, fallback = ""): string {
  const v = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

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

/** The pull request number when running on a pull_request(_target) event. */
function pullRequestNumber(): number | undefined {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return undefined;
  try {
    const event = JSON.parse(readFileSync(path, "utf8")) as { pull_request?: { number?: number } };
    return typeof event.pull_request?.number === "number" ? event.pull_request.number : undefined;
  } catch {
    return undefined;
  }
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

  if (!["error", "warning", "note", "none"].includes(failOn)) return fail(`Input fail-on must be error, warning, note or none (got "${failOn}")`);
  if (suite && !["default", "security-extended", "security-and-quality", "all"].includes(suite)) return fail(`Input suite must be default, security-extended, security-and-quality or all (got "${suite}")`);
  if (threatModels.some((t) => t !== "remote" && t !== "local")) return fail(`Input threat-models may only contain remote and local`);
  if (!["auto", "true", "false", "always", "never"].includes(upload)) return fail(`Input upload must be auto, true or false (got "${upload}")`);
  const prScope = input("pr-scope", "changed-lines") as PrScope;
  if (!["changed-lines", "changed-files", "all"].includes(prScope)) return fail(`Input pr-scope must be changed-lines, changed-files or all (got "${prScope}")`);

  log(`${TOOL_NAME} ${VERSION}: scanning ${relative(workspace, root) || "."}`);
  let result;
  try {
    result = scan({
      root,
      configPath: configInput ? resolve(workspace, configInput) : undefined,
      suite: suite || undefined,
      runtime: input("runtime") || undefined,
      threatModels: threatModels.length ? threatModels : undefined,
    });
  } catch (e) {
    if (e instanceof ConfigError) return fail(e.message);
    throw e;
  }
  if (result.projects.length === 0) warn(`No GameMaker project (.yyp) or .gml files found under ${relative(workspace, root) || "."}. Set the "path" input to your project folder.`);

  const toRepoPath = (file: string) => relative(workspace, join(root, file)).split(sep).join("/");

  // File names and code from the scanned repo are printed below; pause workflow-command
  // processing so a file named "::error::..." can't inject annotations or commands.
  const resumeToken = randomUUID().replace(/-/g, "");
  log(`::group::Findings (${result.findings.length})`);
  log(`::stop-commands::${resumeToken}`);
  process.stdout.write(formatText(result, { color: true, showPaths: true }));
  log(`::${resumeToken}::`);
  log("::endgroup::");

  const sarif = toSarif(result, {
    toolName: TOOL_NAME,
    toolVersion: VERSION,
    informationUri: REPOSITORY_URL,
    scanRoot: root,
    uriBase: workspace,
    category: input("category", "gml-code-scanner"),
  });
  mkdirSync(dirname(sarifFile), { recursive: true });
  writeFileSync(sarifFile, JSON.stringify(sarif, null, 2));
  log(`SARIF written to ${relative(workspace, sarifFile)}`);

  // On pull requests, report only what the pull request changed; the SARIF keeps everything.
  let reported = result.findings;
  let scopeNote = "";
  const pull = pullRequestNumber();
  if (pull !== undefined && prScope !== "all") {
    try {
      const changes = await fetchPullRequestChanges({
        token: input("token") || process.env.GITHUB_TOKEN || "",
        apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
        repository: process.env.GITHUB_REPOSITORY ?? "",
        pull,
      });
      reported = result.findings.filter((f) => inScope(f, changes, toRepoPath, prScope));
      scopeNote = `Showing ${reported.length} finding${reported.length === 1 ? "" : "s"} on ${prScope === "changed-lines" ? "lines" : "files"} changed by this pull request. The whole project has ${result.findings.length}; all of them are in the SARIF file.`;
      log(scopeNote);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`Could not limit results to this pull request's changes (${msg.replace(/.$/, "")}). Reporting all findings instead.`);
    }
  }

  if (input("annotations", "true") === "true") {
    const max = Number(input("max-annotations", "50")) || 50;
    const annotations = formatAnnotations(reported, toRepoPath, max);
    if (annotations) log(annotations);
  }

  // Upload to code scanning, like CodeQL's analyze step.
  let uploadNote = "";
  if (upload !== "false" && upload !== "never") {
    const token = input("token") || process.env.GITHUB_TOKEN || "";
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;
    const ref = process.env.GITHUB_REF;
    const required = upload === "true" || upload === "always";
    if (!token || !repository || !sha || !ref) {
      const msg = "Skipping the code scanning upload: not running in GitHub Actions (or no token).";
      if (required) fail(msg);
      else log(msg);
    } else {
      try {
        const res = await uploadSarif(sarif, {
          token,
          apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
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
    }
  }

  if (input("step-summary", "true") === "true" && process.env.GITHUB_STEP_SUMMARY) {
    let summary = formatStepSummary({ ...result, findings: reported }, toRepoPath, { serverUrl: process.env.GITHUB_SERVER_URL, repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA });
    if (scopeNote) summary = summary.replace("## GML Code Scanner\n\n", `## GML Code Scanner\n\n> ${scopeNote}\n\n`);
    if (uploadNote) summary += `\n${uploadNote}\n`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  const counts = { error: 0, warning: 0, note: 0 };
  for (const f of reported) counts[f.severity]++;
  setOutput("sarif-file", relative(workspace, sarifFile).split(sep).join("/"));
  setOutput("findings", reported.length);
  setOutput("total-findings", result.findings.length);
  setOutput("errors", counts.error);
  setOutput("warnings", counts.warning);
  setOutput("notes", counts.note);

  if (exceedsThreshold({ ...result, findings: reported }, failOn)) {
    fail(`GML Code Scanner found problems at or above "${failOn}" severity (${counts.error} errors, ${counts.warning} warnings, ${counts.note} notes). Set fail-on: none to report without failing.`);
  }
}

run().catch((e) => fail(`GML Code Scanner crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
