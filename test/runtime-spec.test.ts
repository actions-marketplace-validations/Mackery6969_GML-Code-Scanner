import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/engine/config.ts";
import { scan } from "../src/engine/scanner.ts";
import { F_DEPRECATED, F_PURE, loadRuntimeSpec, RuntimeSpecError, V_DEPRECATED, V_INSTANCE, V_READONLY } from "../src/semantic/runtime-spec.ts";
import { writeProject } from "./helpers.ts";

const GML_SPEC = `<?xml version="1.0" encoding="utf-8"?>
<GameMakerLanguageSpec RuntimeVersion="2023.1" Module="Base">
  <Functions>
    <Function Name="show_debug_message" Deprecated="false" ReturnType="Undefined" Pure="false">
      <Parameter Name="str" Type="Any" Optional="false" />
      <Parameter Name="..." Type="Any" Optional="true" />
    </Function>
    <Function Name="fake_2023_fn" Deprecated="false" ReturnType="Real" Pure="true">
      <Parameter Name="a" Type="Real" Optional="false" />
      <Parameter Name="b" Type="Real" Optional="true" />
    </Function>
  </Functions>
  <Variables>
    <Variable Name="fake_2023_var" Type="Real" Deprecated="false" Get="true" Set="false" Instance="false" />
  </Variables>
  <Constants>
    <Constant Name="fake_2023_const" Class="x" Type="Real" Deprecated="true" />
  </Constants>
</GameMakerLanguageSpec>
`;
const FNAMES = "// comment\nold_fn(a,[b])&\nfake_fnames_var@\n";

/** A fake installed runtime: `<dir>/runtimes/runtime-2023.1.1.81`. */
function runtimeFiles(extra: Record<string, string> = {}): Record<string, string> {
  return { "runtimes/runtime-2023.1.1.81/GmlSpec.xml": GML_SPEC, "runtimes/runtime-2023.1.1.81/fnames": FNAMES, ...extra };
}

describe("installed runtime data", () => {
  it("reads GmlSpec.xml and fnames", () => {
    const dir = writeProject(runtimeFiles(), { yyp: false });
    const spec = loadRuntimeSpec(join(dir, "runtimes", "runtime-2023.1.1.81"));
    assert.equal(spec.version, "2023.1.1.81");
    assert.deepEqual(spec.functions.get("show_debug_message"), [1, -1, "Undefined", 0]);
    assert.deepEqual(spec.functions.get("fake_2023_fn"), [1, 2, "Real", F_PURE]);
    assert.deepEqual(spec.functions.get("old_fn"), [1, 2, "Any", F_DEPRECATED]);
    assert.deepEqual(spec.variables.get("fake_2023_var"), ["Real", V_READONLY]);
    assert.deepEqual(spec.variables.get("fake_fnames_var"), ["Any", V_INSTANCE]);
    assert.deepEqual(spec.constants.get("fake_2023_const"), ["Real", V_DEPRECATED]);
  });

  it("takes the version from receipt.json when the folder name has none", () => {
    const dir = writeProject({ "rt/fnames": FNAMES, "rt/receipt.json": JSON.stringify({ base: { Version: "2024.2.0.163" } }) }, { yyp: false });
    assert.equal(loadRuntimeSpec(join(dir, "rt")).version, "2024.2.0.163");
  });

  it("rejects folders that aren't a runtime", () => {
    const dir = writeProject({ "runtime-2023.1.1.81/readme.txt": "", "other/fnames": FNAMES }, { yyp: false });
    assert.throws(() => loadRuntimeSpec(join(dir, "runtime-2023.1.1.81")), (e) => e instanceof RuntimeSpecError && /No GmlSpec\.xml or fnames/.test(e.message));
    assert.throws(() => loadRuntimeSpec(join(dir, "other")), (e) => e instanceof RuntimeSpecError && /Can't tell which GameMaker runtime/.test(e.message));
  });

  it("checks projects on the runtime's release line against it", () => {
    const code = "show_debug_message(fake_2023_fn(1));\narray_foreach([], show_debug_message);\n";
    const dir = writeProject({ "objects/obj_test/Step_0.gml": code }, { ideVersion: "2023.1.1.62" });
    const rules = ["gml/runtime-unavailable", "gml/undefined-function"];
    const ids = (r: ReturnType<typeof scan>) => r.findings.map((f) => `${f.ruleId}:${f.location.startLine}`);

    // The bundled data has no 2023.1 runtime: availability checks are off, and the 2023-only function is unknown.
    const before = scan({ root: dir, config: defaultConfig(), onlyRules: rules });
    assert.equal(before.projects[0].runtimeChecks, false);
    assert.deepEqual(ids(before), ["gml/undefined-function:1"]);

    const runtimeDir = writeProject(runtimeFiles(), { yyp: false });
    const after = scan({ root: dir, config: defaultConfig(), onlyRules: rules, runtimeSpec: loadRuntimeSpec(join(runtimeDir, "runtimes", "runtime-2023.1.1.81")) });
    assert.equal(after.projects[0].runtimeChecks, true);
    assert.equal(after.projects[0].runtimeData, "2023.1.1.81");
    assert.deepEqual(ids(after), ["gml/runtime-unavailable:2"]);
    assert.match(after.findings[0].message, /array_foreach.*runtime 2023\.1\.1\.81/);
  });

  it("doesn't scan a runtime installed inside the scanned folder", () => {
    const dir = writeProject(runtimeFiles({ "runtimes/runtime-2023.1.1.81/stray.gml": "x = ;\n", "game.gml": "show_debug_message(1);\n" }), { yyp: false });
    const spec = loadRuntimeSpec(join(dir, "runtimes", "runtime-2023.1.1.81"));
    const files = (r: ReturnType<typeof scan>) => r.findings.map((f) => f.location.file);
    const without = scan({ root: dir, config: defaultConfig(), onlyRules: ["gml/syntax-error"] });
    assert.deepEqual(files(without), ["runtimes/runtime-2023.1.1.81/stray.gml"]);
    const withSpec = scan({ root: dir, config: defaultConfig(), onlyRules: ["gml/syntax-error"], runtimeSpec: spec });
    assert.deepEqual(files(withSpec), []);
    assert.equal(withSpec.filesScanned, 1);
  });
});
