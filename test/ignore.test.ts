import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { globToRegExp } from "../src/engine/config.ts";
import { compileIgnoreLines, loadIgnoreMatcher, matcherFor, parseIgnoreLine } from "../src/engine/ignore.ts";
import { eventCode, scanFiles } from "./helpers.ts";

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

function folderWith(files: Record<string, string>, repository = true): string {
  const root = mkdtempSync(join(tmpdir(), "gmlscan-ignore-"));
  folders.push(root);
  if (repository) mkdirSync(join(root, ".git"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe(".gmlscanignore", () => {
  it("reads lines like .gitignore", () => {
    assert.equal(parseIgnoreLine(""), undefined);
    assert.equal(parseIgnoreLine("   "), undefined);
    assert.equal(parseIgnoreLine("# vendored code"), undefined);
    assert.ok(parseIgnoreLine("\\#notes.gml")?.pattern.test("scripts/#notes.gml"));
    assert.equal(parseIgnoreLine("!scripts/keep.gml")?.negated, true);
    assert.ok(parseIgnoreLine("scripts/vendor_*/   ")?.pattern.test("scripts/vendor_input/vendor_input.gml"));
  });

  it("a trailing slash matches folders only, at any depth unless anchored", () => {
    const vendor = parseIgnoreLine("vendor/");
    assert.ok(vendor?.pattern.test("vendor/lib.gml"));
    assert.ok(vendor?.pattern.test("scripts/vendor/lib.gml"));
    assert.ok(!vendor?.pattern.test("scripts/vendor"));
    const anchored = parseIgnoreLine("/vendor/");
    assert.ok(anchored?.pattern.test("vendor/lib.gml"));
    assert.ok(!anchored?.pattern.test("scripts/vendor/lib.gml"));
  });

  it("the last matching line wins, so ! brings files back", () => {
    const isIgnored = matcherFor(compileIgnoreLines(["scripts/vendor_*/**", "!scripts/vendor_keep/**"]));
    assert.ok(isIgnored("scripts/vendor_input/vendor_input.gml"));
    assert.ok(!isIgnored("scripts/vendor_keep/vendor_keep.gml"));
    assert.ok(!isIgnored("scripts/mine/mine.gml"));
  });

  it("config ignore patterns with a trailing slash now match", () => {
    assert.ok(globToRegExp("extensions/").test("extensions/ext/ext.gml"));
    assert.ok(globToRegExp("scripts/vendor_*/**").test("scripts/vendor_input/vendor_input.gml"));
  });

  it("files in parent folders apply up to the repository root, relative to where they sit", () => {
    const repository = folderWith({
      ".gmlscanignore": "vendor_*/\ngame/scripts/generated/\n",
      "game/.gmlscanignore": "!scripts/vendor_keep/\n",
    });
    const isIgnored = loadIgnoreMatcher(join(repository, "game"), ["scripts/scratch_*/"]);
    assert.ok(isIgnored("scripts/vendor_input/vendor_input.gml"));
    assert.ok(isIgnored("scripts/generated/generated.gml"));
    assert.ok(isIgnored("scripts/scratch_test/scratch_test.gml"));
    assert.ok(!isIgnored("scripts/vendor_keep/vendor_keep.gml"));
    assert.ok(!isIgnored("scripts/player/player.gml"));
  });

  it("outside a repository only the scanned folder's file is read", () => {
    const outside = folderWith({ ".gmlscanignore": "scripts/\n", "game/.gmlscanignore": "objects/\n" }, false);
    const isIgnored = loadIgnoreMatcher(join(outside, "game"), []);
    assert.ok(!isIgnored("scripts/player/player.gml"));
    assert.ok(isIgnored("objects/obj_player/Step_0.gml"));
  });

  it("an exception inside an ignored folder is still scanned", () => {
    const files = {
      ...eventCode("x = 1;"),
      "scripts/vendor_keep/vendor_keep.gml": "function vendor_keep() { exit; return 1; }",
      "scripts/vendor_lib/vendor_lib.gml": "function vendor_lib() { exit; return 1; }",
      ".gmlscanignore": "scripts/\n!scripts/vendor_keep/\n",
    };
    const findings = scanFiles(files, { rules: ["gml/unreachable-code"] });
    assert.deepEqual(findings.map((finding) => finding.location.file), ["scripts/vendor_keep/vendor_keep.gml"]);
  });

  it("drops findings in ignored files but keeps their definitions", () => {
    const files = {
      ...eventCode("exit; x = vendor_helper(1);"),
      "scripts/vendor_lib/vendor_lib.gml": "function vendor_helper(a) { exit; return a; }",
      ".gmlscanignore": "# third-party code\nscripts/vendor_*/\n",
    };
    const findings = scanFiles(files, { rules: ["gml/undefined-function", "gml/unreachable-code"] });
    assert.deepEqual(
      findings.map((finding) => [finding.ruleId, finding.location.file]),
      [["gml/unreachable-code", "objects/obj_test/Step_0.gml"]],
    );
  });
});
