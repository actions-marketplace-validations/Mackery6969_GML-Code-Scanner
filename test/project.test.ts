import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join, relative, sep } from "node:path";
import { eventCode, findingsFor, scanFiles, scriptCode, writeProject } from "./helpers.ts";

describe("project rules", () => {
  it("duplicate-resource", () => {
    const dup = `    {"id":{"name":"obj_test","path":"objects/obj_test/obj_test.yy",},"order":1,},`;
    const f = findingsFor(eventCode("x = 1;"), "gml/duplicate-resource", { extraEntries: [dup] });
    assert.equal(f.length, 1);
    assert.equal(f[0].location.file, "TestGame.yyp");
    assert.match(f[0].message, /registered 2 times/);
  });

  it("missing-resource-file", () => {
    const ghost = `    {"id":{"name":"obj_ghost","path":"objects/obj_ghost/obj_ghost.yy",},"order":1,},`;
    const f = findingsFor(eventCode("x = 1;"), "gml/missing-resource-file", { extraEntries: [ghost] });
    assert.equal(f.length, 1);
    assert.match(f[0].message, /obj_ghost/);
  });

  it("unregistered-resource (used and unused)", () => {
    const files = { ...eventCode("instance_create_layer(0, 0, \"Instances\", obj_orphan);", "Create_0"), "objects/obj_orphan/Create_0.gml": "x = 1;" };
    const used = findingsFor(files, "gml/unregistered-resource", { unregistered: ["obj_orphan"] });
    assert.equal(used.length, 1);
    assert.equal(used[0].severity, "error");
    assert.equal(used[0].location.file, "objects/obj_test/Create_0.gml");
    const unused = findingsFor({ ...eventCode("x = 1;", "Create_0"), "objects/obj_orphan/Create_0.gml": "x = 1;" }, "gml/unregistered-resource", { unregistered: ["obj_orphan"] });
    assert.equal(unused.length, 1);
    assert.equal(unused[0].severity, "warning");
  });

  it("orphaned-event-file", () => {
    const files = {
      "objects/obj_test/Create_0.gml": "x = 1;",
      "objects/obj_test/Step_0.gml": "x += 1;",
      "objects/obj_test/obj_test.yy": `{"resourceType":"GMObject","name":"obj_test","eventList":[{"eventNum":0,"eventType":0,"collisionObjectId":null,},],"parentObjectId":null,"properties":[],}`,
    };
    const f = findingsFor(files, "gml/orphaned-event-file");
    assert.equal(f.length, 1);
    assert.match(f[0].message, /Step event file/);
  });

  it("unused-object and unused-function", () => {
    const files = {
      ...eventCode("scr_used();", "Create_0"),
      "objects/obj_lonely/Create_0.gml": "x = 1;",
      ...scriptCode("function scr_used() {}\nfunction scr_dead() { scr_dead(); }", "scr_lib"),
    };
    const objs = findingsFor(files, "gml/unused-object");
    assert.deepEqual(objs.map((f) => /`(\w+)`/.exec(f.message)![1]).sort(), ["obj_lonely", "obj_test"]);
    const fns = findingsFor(files, "gml/unused-function");
    assert.deepEqual(fns.map((f) => f.message), ["Unused function `scr_dead`."]);
  });

  it("unused-function ignores gml_pragma(\"global\") calls and enum holders", () => {
    const files = {
      ...eventCode("x = e_dir.left;", "Create_0"),
      ...scriptCode('function __init_a() {\n\tgml_pragma("global", "__init_a();");\n}', "scr_init_a"),
      ...scriptCode("function __init_b() {\n\tgml_pragma(\"global\", @'__init_b()');\n}", "scr_init_b"),
      ...scriptCode("function __dirs() {\n\tenum e_dir { left, right }\n}", "scr_dirs"),
      ...scriptCode("function __unused_enum() {\n\tenum e_unused { a }\n}", "scr_unused_enum"),
    };
    assert.deepEqual(findingsFor(files, "gml/unused-function").map((f) => f.message), ["Unused function `__unused_enum`."]);
  });

  it("objects placed in rooms are used", () => {
    const files = {
      ...eventCode("x = 1;", "Create_0"),
      "rooms/rm_main/rm_main.yy": `{"resourceType":"GMRoom","name":"rm_main","layers":[{"instances":[{"name":"inst_1","objectId":{"name":"obj_test","path":"objects/obj_test/obj_test.yy",},},],"layers":[],},],}`,
    };
    assert.equal(findingsFor(files, "gml/unused-object").length, 0);
  });

  it("duplicate-function, duplicate-macro, duplicate-enum", () => {
    const files = {
      ...scriptCode("function helper() {}\n#macro SPEED 4\nenum E { A, B, A }", "scr_a"),
      ...scriptCode("function helper() {}\n#macro SPEED 5\n#macro Debug:SPEED 9\nenum E { C }", "scr_b"),
    };
    assert.equal(findingsFor(files, "gml/duplicate-function").length, 1);
    assert.equal(findingsFor(files, "gml/duplicate-macro").length, 1);
    assert.equal(findingsFor(files, "gml/duplicate-enum").length, 2);
  });

  it("never reads resources outside the project", () => {
    // A hostile .yyp points a room at a file outside the project; its instances must not be loaded.
    const outside = writeProject({ "evil/evil.yy": `{"resourceType":"GMRoom","name":"evil","layers":[{"instances":[{"name":"inst_OUTSIDE"}],"layers":[]}]}` }, { yyp: false });
    const rel = relative(join(outside, ".."), outside).split(sep).join("/");
    const entry = `    {"id":{"name":"evil","path":"rooms/../../${rel}/evil/evil.yy",},"order":0,},`;
    const findings = scanFiles(eventCode("x = inst_OUTSIDE;", "Create_0"), { extraEntries: [entry], rules: ["gml/undefined-variable", "gml/missing-resource-file"] });
    assert.ok(findings.some((f) => f.ruleId === "gml/undefined-variable" && /inst_OUTSIDE/.test(f.message)));
    assert.ok(findings.some((f) => f.ruleId === "gml/missing-resource-file"));
  });

  it("folders without a .yyp skip whole-project checks", () => {
    assert.equal(findingsFor(eventCode("scr_elsewhere(); x = y_from_elsewhere;"), "gml/undefined-function", { yyp: false }).length, 0);
  });
});
