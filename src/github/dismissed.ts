/**
 * Leaves out findings whose code scanning alert was dismissed in the Security tab, so the
 * action's annotations and fail-on agree with GitHub. A dismissal sticks to the alert's
 * fingerprint (rule, file and line text, see report/sarif.ts), but the alerts API doesn't
 * return fingerprints, so alerts are matched to findings by where they are in this upload.
 */
import type { Finding } from "../engine/types.ts";

export interface DismissedAlert {
  ruleId: string;
  /** Repository-relative path. */
  path: string;
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

interface AlertJson {
  rule?: { id?: string | null };
  most_recent_instance?: {
    commit_sha?: string;
    category?: string;
    location?: { path?: string; start_line?: number; end_line?: number; start_column?: number; end_column?: number };
  };
}

export interface DismissedOptions {
  token: string;
  apiUrl: string;
  /** owner/repo */
  repository: string;
  /** The ref the results were uploaded for. */
  ref: string;
  /** The commit the results were uploaded for. */
  sha: string;
  toolName: string;
  category: string;
}

const trimSlashes = (s: string) => s.replace(/\/+$/, "");

/** Dismissed alerts whose latest instance on `ref` comes from the analysis of `sha`. */
export async function fetchDismissedAlerts(opts: DismissedOptions): Promise<DismissedAlert[]> {
  const alerts: DismissedAlert[] = [];
  const base = opts.apiUrl.replace(/\/$/, "");
  const query = `tool_name=${encodeURIComponent(opts.toolName)}&state=dismissed&ref=${encodeURIComponent(opts.ref)}&per_page=100`;
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(`${base}/repos/${opts.repository}/code-scanning/alerts?${query}&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${opts.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gml-code-scanner",
      },
    });
    if (!res.ok) throw new Error(`Could not list dismissed code scanning alerts (HTTP ${res.status}).`);
    const items = (await res.json()) as AlertJson[];
    for (const a of items) {
      const instance = a.most_recent_instance;
      const loc = instance?.location;
      // An instance from an earlier commit may sit on a different line by now.
      if (instance?.commit_sha !== opts.sha || !a.rule?.id || !loc?.path || !loc.start_line) continue;
      if (instance.category !== undefined && trimSlashes(instance.category) !== trimSlashes(opts.category)) continue;
      alerts.push({ ruleId: a.rule.id, path: loc.path, startLine: loc.start_line, startColumn: loc.start_column, endLine: loc.end_line, endColumn: loc.end_column });
    }
    if (items.length < 100) break;
  }
  return alerts;
}

/** Splits findings into those still open and those whose alert is dismissed. */
export function splitDismissed(findings: Finding[], alerts: DismissedAlert[], toRepoPath: (file: string) => string): { open: Finding[]; dismissed: Finding[] } {
  const key = (ruleId: string, path: string, line: number) => `${ruleId}\0${path}\0${line}`;
  const byLine = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = key(f.ruleId, toRepoPath(f.location.file), f.location.startLine);
    const list = byLine.get(k);
    if (list) list.push(f);
    else byLine.set(k, [f]);
  }
  const dismissed = new Set<Finding>();
  for (const a of alerts) {
    const candidates = (byLine.get(key(a.ruleId, a.path, a.startLine)) ?? []).filter((f) => !dismissed.has(f));
    // Several findings of one rule on one line are told apart by their columns; if none
    // matches exactly, the alert is only trusted when the line has a single candidate.
    const exact = candidates.find((f) => f.location.startColumn === a.startColumn && f.location.endLine === a.endLine && f.location.endColumn === a.endColumn);
    const match = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (match) dismissed.add(match);
  }
  return { open: findings.filter((f) => !dismissed.has(f)), dismissed: findings.filter((f) => dismissed.has(f)) };
}
