import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import type { Finding } from "../src/engine/types.ts";
import { type DismissedAlert, fetchDismissedAlerts, splitDismissed } from "../src/github/dismissed.ts";

const finding = (ruleId: string, file: string, startLine: number, startColumn = 1, endColumn = 10): Finding => ({
  ruleId,
  severity: "error",
  message: "m",
  location: { file, startLine, startColumn, endLine: startLine, endColumn },
});

const alert = (ruleId: string, path: string, startLine: number, startColumn = 1, endColumn = 10): DismissedAlert => ({ ruleId, path, startLine, startColumn, endLine: startLine, endColumn });

const toRepo = (f: string) => `game/${f}`;

describe("dismissed alerts", () => {
  it("leaves out findings whose alert is dismissed", () => {
    const a = finding("gml/x", "scripts/a/a.gml", 3);
    const b = finding("gml/x", "scripts/a/a.gml", 4);
    const c = finding("gml/y", "scripts/a/a.gml", 3);
    const { open, dismissed } = splitDismissed([a, b, c], [alert("gml/x", "game/scripts/a/a.gml", 3)], toRepo);
    assert.deepEqual(dismissed, [a]);
    assert.deepEqual(open, [b, c]);
  });

  it("tells findings on one line apart by their columns", () => {
    const first = finding("gml/x", "s.gml", 5, 1, 4);
    const second = finding("gml/x", "s.gml", 5, 8, 12);
    const { open, dismissed } = splitDismissed([first, second], [alert("gml/x", "game/s.gml", 5, 8, 12)], toRepo);
    assert.deepEqual(dismissed, [second]);
    assert.deepEqual(open, [first]);
  });

  it("keeps findings it can't tell apart, but trusts a lone candidate", () => {
    const first = finding("gml/x", "s.gml", 5, 1, 4);
    const second = finding("gml/x", "s.gml", 5, 8, 12);
    assert.equal(splitDismissed([first, second], [alert("gml/x", "game/s.gml", 5, 2, 3)], toRepo).dismissed.length, 0);
    assert.deepEqual(splitDismissed([first], [alert("gml/x", "game/s.gml", 5, 2, 3)], toRepo).dismissed, [first]);
  });

  it("hides one finding per alert at the same location", () => {
    const twins = [finding("gml/x", "s.gml", 5), finding("gml/x", "s.gml", 5)];
    const { open, dismissed } = splitDismissed(twins, [alert("gml/x", "game/s.gml", 5)], toRepo);
    assert.equal(dismissed.length, 1);
    assert.equal(open.length, 1);
  });

  it("lists dismissed alerts for this commit and category, with pagination", async () => {
    const instance = (path: string, line: number, sha = "abc123", category = "gml-code-scanner/") => ({
      ref: "refs/pull/7/merge",
      commit_sha: sha,
      category,
      location: { path, start_line: line, end_line: line, start_column: 1, end_column: 10 },
    });
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 100 }, (_, i) => ({ number: i + 1, rule: { id: "gml/x" }, most_recent_instance: instance(`f${i}.gml`, 1) })),
      "2": [
        { number: 101, rule: { id: "gml/y" }, most_recent_instance: instance("old.gml", 2, "def456") },
        { number: 102, rule: { id: "gml/y" }, most_recent_instance: instance("other.gml", 2, "abc123", "other-game/") },
        { number: 103, rule: { id: "gml/y" }, most_recent_instance: instance("last.gml", 9) },
      ],
    };
    const urls: string[] = [];
    const server = createServer((req, res) => {
      urls.push(req.url ?? "");
      const page = new URL(req.url ?? "", "http://x").searchParams.get("page") ?? "1";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pages[page] ?? []));
    });
    server.listen(0);
    after(() => server.close());
    const alerts = await fetchDismissedAlerts({
      token: "t",
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      repository: "me/game",
      ref: "refs/pull/7/merge",
      sha: "abc123",
      toolName: "GML Code Scanner",
      category: "gml-code-scanner",
    });
    assert.equal(alerts.length, 101);
    assert.deepEqual(alerts.at(-1), { ruleId: "gml/y", path: "last.gml", startLine: 9, startColumn: 1, endLine: 9, endColumn: 10 });
    assert.equal(urls.length, 2);
    const q = new URL(urls[0], "http://x").searchParams;
    assert.equal(q.get("tool_name"), "GML Code Scanner");
    assert.equal(q.get("state"), "dismissed");
    assert.equal(q.get("ref"), "refs/pull/7/merge");
  });

  it("reports API errors", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end("{}");
    });
    server.listen(0);
    after(() => server.close());
    const opts = { token: "t", apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repository: "me/game", ref: "refs/heads/main", sha: "a", toolName: "GML Code Scanner", category: "gml-code-scanner" };
    await assert.rejects(fetchDismissedAlerts(opts), /HTTP 403/);
  });
});
