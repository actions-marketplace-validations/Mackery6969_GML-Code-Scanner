import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventCode, findingsFor, scriptCode } from "./helpers.ts";

const NET = "Other_68"; // Async - Networking
const HTTP = "Other_62"; // Async - HTTP

describe("taint tracking", () => {
  it("finds network data reaching script_execute", () => {
    const f = findingsFor(eventCode(`var buf = async_load[? "buffer"]; var cmd = buffer_read(buf, buffer_string); script_execute(asset_get_index(cmd));`, NET), "gml/code-injection");
    assert.equal(f.length, 1);
    assert.ok(f[0].flow && f[0].flow.length >= 3, "has a data-flow path");
    assert.match(f[0].message, /network packet/);
  });

  it("follows JSON fields and struct members", () => {
    const f = findingsFor(eventCode(`var data = json_parse(async_load[? "result"]); file_delete(data.slot + ".sav");`, HTTP), "gml/path-injection");
    assert.equal(f.length, 1);
  });

  it("follows instance variables across events", () => {
    const files = eventCode(`pending = async_load[? "result"];`, HTTP, { "objects/obj_test/Step_0.gml": "if (pending != undefined) variable_instance_set(id, pending, 1);" });
    assert.equal(findingsFor(files, "gml/variable-injection").length, 1);
  });

  it("follows calls through function summaries", () => {
    const files = {
      ...scriptCode("function run_cmd(name) { script_execute(asset_get_index(name)); }\nfunction unwrap(p) { return p.cmd; }", "scr_net"),
      ...eventCode(`var packet = json_parse(async_load[? "result"]); run_cmd(unwrap(packet));`, HTTP),
    };
    const f = findingsFor(files, "gml/code-injection");
    assert.equal(f.length, 1);
    assert.ok(f[0].flow!.some((s) => /passed to run_cmd/.test(s.message)));
  });

  it("respects allow-list guards and early exits", () => {
    const guarded = `var d = json_parse(async_load[? "result"]); var k = d.key;
      if (!array_contains(["skin", "emote"], k)) exit;
      variable_instance_set(id, k, 1);`;
    assert.equal(findingsFor(eventCode(guarded, HTTP), "gml/variable-injection").length, 0);
    const branch = `var k = async_load[? "result"]; if (k == "skin") variable_instance_set(id, k, 1);`;
    assert.equal(findingsFor(eventCode(branch, HTTP), "gml/variable-injection").length, 0);
    const sw = `var k = async_load[? "result"]; switch (k) { case "skin": variable_instance_set(id, k, 1); break; }`;
    assert.equal(findingsFor(eventCode(sw, HTTP), "gml/variable-injection").length, 0);
  });

  it("ignores safe async_load keys and non-network async events", () => {
    assert.equal(findingsFor(eventCode(`script_execute(async_load[? "id"]);`, HTTP), "gml/code-injection").length, 0);
    assert.equal(findingsFor(eventCode(`script_execute(async_load[? "filename"]);`, "Other_60"), "gml/code-injection").length, 0);
  });

  it("treats URL-prefixed values and filename_name() as path-safe", () => {
    assert.equal(findingsFor(eventCode(`sprite_add("https://cdn.example.com/" + async_load[? "result"], 1, false, false, 0, 0);`, HTTP), "gml/path-injection").length, 0);
    assert.equal(findingsFor(eventCode(`file_delete(filename_name(async_load[? "result"]));`, HTTP), "gml/path-injection").length, 0);
  });

  it("numeric conversion blocks path/url sinks but not code sinks", () => {
    assert.equal(findingsFor(eventCode(`file_delete(real(async_load[? "result"]));`, HTTP), "gml/path-injection").length, 0);
    assert.equal(findingsFor(eventCode(`script_execute(real(async_load[? "result"]));`, HTTP), "gml/code-injection").length, 1);
  });

  it("local threat model is opt-in", () => {
    const files = eventCode(`var name = get_string("Save name", ""); file_text_open_write(name);`, "Create_0");
    assert.equal(findingsFor(files, "gml/path-injection").length, 0);
    assert.equal(findingsFor(files, "gml/path-injection", { config: { threatModels: ["remote", "local"] } }).length, 1);
  });

  it("supports custom sources and sinks", () => {
    const files = eventCode(`var msg = net_receive(); my_run(msg);`, "Step_0");
    const config = { taint: { sources: [{ function: "net_receive", kind: "remote" as const }], sinks: [{ function: "my_run", arguments: [0], kind: "command-injection" }] } };
    assert.equal(findingsFor(files, "gml/command-injection", { config }).length, 1);
  });
});

/**
 * Provider-format test credentials are assembled at runtime so the repository never
 * contains a literal that GitHub secret scanning (or push protection) flags. None are real.
 */
const fake = {
  githubToken: ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"),
  stripeKey: ["sk", "live", "51FakeKeyForTests0000000000"].join("_"),
  discordWebhook: ["https://discord.com/api/", "webhooks/123456789012345678/", "abcdefghijklmnopqrstuvwxyzABCDEF_-123"].join(""),
};

describe("other security rules", () => {
  it("hardcoded-secret in code", () => {
    assert.equal(findingsFor(eventCode(`hook = "${fake.discordWebhook}";`, "Create_0"), "gml/hardcoded-secret").length, 1);
    assert.match(findingsFor(eventCode(`key = "${fake.stripeKey}";`, "Create_0"), "gml/hardcoded-secret")[0]?.message ?? "", /Stripe/);
    // Fake key used as test input for the hardcoded-secret rule; not a real credential.
    // nosemgrep: generic.secrets.security.detected-generic-api-key.detected-generic-api-key
    assert.equal(findingsFor(eventCode(`api_key = "k3J9sd8f7G6h5J4k3L2m1N0pQ9r8S7t6";`, "Create_0"), "gml/hardcoded-secret").length, 1);
    assert.equal(findingsFor(eventCode(`api_key = "YOUR_API_KEY_HERE";`, "Create_0"), "gml/hardcoded-secret").length, 0);
    assert.equal(findingsFor(eventCode(`keyboard_key = "abcdefghijklmnop1234";`, "Create_0"), "gml/hardcoded-secret").length, 0);
  });

  it("hardcoded-secret masks the secret in report snippets", () => {
    const token = fake.githubToken;
    const [f] = findingsFor(eventCode(`gh = "${token}";`, "Create_0"), "gml/hardcoded-secret");
    assert.ok(f.snippet && !f.snippet.includes(token) && f.snippet.includes("ghp_****"), f.snippet);
  });

  it("hardcoded-secret in datafiles and workflows", () => {
    const f = findingsFor(
      {
        ...eventCode("x = 1;", "Create_0"),
        "datafiles/config.ini": "[server]\napi_secret=Zx8Kq2Lm9Pw4Rt7Yv3Nb6Hj1\n",
        ".github/workflows/build.yml": `env:\n  GH: ${fake.githubToken}\n`,
      },
      "gml/hardcoded-secret",
    );
    assert.equal(f.length, 2);
    assert.ok(f.some((x) => x.location.file === "datafiles/config.ini"));
  });

  it("insecure-http", () => {
    assert.equal(findingsFor(eventCode(`http_get("http://api.example.com/scores");`, "Create_0"), "gml/insecure-http").length, 1);
    assert.equal(findingsFor(eventCode(`http_get("https://api.example.com/scores"); http_get("http://localhost:8080/x");`, "Create_0"), "gml/insecure-http").length, 0);
    const macro = scriptCode(`#macro API_URL "http://api.example.com"`, "scr_config");
    assert.equal(findingsFor({ ...macro, ...eventCode(`http_get(API_URL + "/scores");`, "Create_0") }, "gml/insecure-http").length, 1);
  });

  it("weak-password-hash, insecure-randomness, sensitive-data-logged", () => {
    assert.equal(findingsFor(eventCode(`hash = md5_string_utf8(password);`, "Create_0"), "gml/weak-password-hash").length, 1);
    assert.equal(findingsFor(eventCode(`session_token = string(irandom(999999));`, "Create_0"), "gml/insecure-randomness").length, 1);
    assert.equal(findingsFor(eventCode(`show_debug_message("login " + auth_token);`, "Create_0"), "gml/sensitive-data-logged").length, 1);
    assert.equal(findingsFor(eventCode(`show_debug_message("keys held: " + string(keys_held));`, "Create_0"), "gml/sensitive-data-logged").length, 0);
  });
});
