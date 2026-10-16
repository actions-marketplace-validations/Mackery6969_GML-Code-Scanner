import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { floorsFromNotes, isCompatible, requirementOf } from "../src/deps/compat.ts";
import type { DependencySpec } from "../src/deps/registry.ts";
import { fetchPackageMetadata, fetchReleases, parseMarketplacePage, parseRuntimeFeed, type Release } from "../src/deps/sources.ts";
import { checkUpdates, newerRuntimes } from "../src/deps/updates.ts";
import { compareGameMaker, compareVersions, updateType, versionMatches } from "../src/deps/version.ts";
import { RemoteZip, Zip } from "../src/deps/zip.ts";
import { ConfigError, loadConfig, resolveConfig, type Config } from "../src/engine/config.ts";
import { fakeFetch, file, githubRelease, json, makeZip, yymps } from "./deps-helpers.ts";
import { scanProject, writeProject } from "./helpers.ts";

describe("versions", () => {
  it("compares library and GameMaker versions", () => {
    assert.equal(compareVersions("9.7.3", "10.0.0"), -1);
    assert.equal(compareVersions("v0.5.0", "0.5.0"), 0);
    assert.equal(compareVersions("1.03.01", "1.3.1"), 0);
    assert.equal(compareVersions("6.4.2-beta", "6.4.2"), -1);
    assert.equal(compareVersions("6.4.2-beta.2", "6.4.2-beta.10"), -1);
    assert.equal(compareVersions("2024.14.4.268", "2024.14.4.222"), 1);
    assert.equal(compareVersions("1.2", "1.2.0"), 0);
  });

  it("classifies updates", () => {
    assert.equal(updateType("1.1.5", "2.2.1"), "major");
    assert.equal(updateType("8.0.0", "8.8.4"), "minor");
    assert.equal(updateType("1.5.0", "1.5.2"), "patch");
  });

  it("matches ignore patterns", () => {
    assert.ok(versionMatches("10.2.0", "10.x"));
    assert.ok(versionMatches("10.2.0", "10"));
    assert.ok(versionMatches("2.1.7", "2.1.*"));
    assert.ok(!versionMatches("2.2.0", "2.1.*"));
    assert.ok(versionMatches("3.0.0", "v3.0.0"));
  });

  it("ignores build numbers when comparing GameMaker releases", () => {
    // IDE 2023.1.1.62 ships runtime 2023.1.1.81.
    assert.equal(compareGameMaker("2023.1.1.62", "2023.1.1.81"), 0);
    assert.equal(compareGameMaker("2023.1.1.62", "2023.4.0"), -1);
    assert.equal(compareGameMaker("2026.0.0.23", "2024.14.4.268"), 1);
  });
});

describe("runtime compatibility", () => {
  const release = (extra: Partial<Release> = {}): Release => ({ version: "2.2.1", prerelease: false, url: "u", assets: [], ...extra });
  const STEAMWORKS_NOTES = `## IMPORTANT

- This extension version will be compatible with the GM 2022.0.1 LTSr1 (upon release)
- This extension is to be used with GM 2023.1 and future releases.
- Requires Steamworks SDK version 1.63`;

  it("reads minimum GameMaker versions from release notes", () => {
    assert.deepEqual(
      floorsFromNotes(STEAMWORKS_NOTES).map((f) => f.version),
      ["2023.1"],
    );
    assert.deepEqual(
      floorsFromNotes("This version requires GameMaker 2024.11 or later.").map((f) => f.version),
      ["2024.11"],
    );
    assert.deepEqual(
      floorsFromNotes("Works with GMS 2.3+ and LTS.").map((f) => f.version),
      ["2.3"],
    );
    assert.deepEqual(floorsFromNotes("Bumped the Steamworks SDK to version 1.63."), []);
  });

  it("takes the stricter of the package's export IDE and the notes", () => {
    const req = requirementOf(release({ notes: STEAMWORKS_NOTES }), { ideVersion: "2022.0.1.0" });
    assert.equal(req?.minimum, "2023.1");
    assert.equal(isCompatible(req, "2023.1.1.62"), true);
    assert.equal(isCompatible(req, "2022.0.3.99"), false);
    assert.equal(requirementOf(release(), { ideVersion: "2024.2.0.163" })?.minimum, "2024.2.0");
  });

  it("is unknown without evidence", () => {
    assert.equal(requirementOf(release()), undefined);
    assert.equal(isCompatible(undefined, "2023.1.1.62"), undefined);
  });

  it("understands Marketplace version labels", () => {
    assert.equal(isCompatible(requirementOf(release({ label: "GMS2.3" })), "2023.1.1.62"), true);
    assert.equal(isCompatible(requirementOf(release({ label: "GMS2" })), "2023.1.1.62"), false);
    assert.equal(isCompatible(requirementOf(release({ label: "GMS1" })), "2023.1.1.62"), false);
  });
});

describe("sources", () => {
  it("parses Marketplace version history", () => {
    const html = `<div class="version_list">
      <div class="version">GMS1 - Version 1.0.19. Published August 19, 2020</div><div class="version_changelist">...</div>
      <div class="version">GMS2 - Version 1.0.56. Published August 21, 2021</div>
      <div class="version">GMS2.3 - Version 1.0.76. Published May 25, 2024</div>
    </div>`;
    const releases = parseMarketplacePage(html, "https://marketplace.gamemaker.io/assets/5992/gmlive");
    assert.deepEqual(
      releases.map((r) => [r.label, r.version, r.publishedAt?.slice(0, 10)]),
      [
        ["GMS1", "1.0.19", "2020-08-19"],
        ["GMS2", "1.0.56", "2021-08-21"],
        ["GMS2.3", "1.0.76", "2024-05-25"],
      ],
    );
    assert.deepEqual(parseMarketplacePage("<li>Version 1.4.1. Published June 26, 2021</li>", "u").map((r) => [r.label, r.version]), [[undefined, "1.4.1"]]);
  });

  it("parses the runtime feeds", () => {
    assert.deepEqual(parseRuntimeFeed("<rss><title>GameMaker Runtime Feed</title><item><title>Version 2024.14.4.268</title></item><item><title>Version 2.3.7.606</title></item></rss>"), ["2024.14.4.268", "2.3.7.606"]);
  });

  it("reads GitHub releases, newest first, with versions from per-package asset names", async () => {
    const spec: DependencySpec = { name: "Firebase Analytics", source: { type: "github", repo: "YoYoGames/GMEXT-Firebase" }, asset: "^Firebase\\.Analytics\\.(?:Ext\\.)?v(\\d+(?:\\.\\d+)+)\\.yymps$" };
    const asset = (name: string) => ({ name, size: 10, browser_download_url: `https://dl/${name}` });
    const { fetch, requests } = fakeFetch((req) =>
      req.url.startsWith("https://api.github.com/repos/YoYoGames/GMEXT-Firebase/releases")
        ? json([
            githubRelease("3.0.0", { assets: [asset("Firebase.Analytics.Ext.v3.0.0.yymps"), asset("Firebase.Firestore.Ext.v3.0.1.yymps")] }),
            githubRelease("3.1.0", { assets: [asset("Firebase.Analytics.Ext.v3.0.2.yymps")] }),
            githubRelease("4.0.0-beta", { draft: true, assets: [asset("Firebase.Analytics.Ext.v4.0.0.yymps")] }),
          ])
        : undefined,
    );
    const releases = await fetchReleases(spec, { fetch, githubToken: "t0k" });
    assert.deepEqual(
      releases.map((r) => [r.version, r.tag, r.packageAsset?.name]),
      [
        ["3.0.2", "3.1.0", "Firebase.Analytics.Ext.v3.0.2.yymps"],
        ["3.0.0", "3.0.0", "Firebase.Analytics.Ext.v3.0.0.yymps"],
      ],
    );
    assert.equal(requests[0].headers.authorization, "Bearer t0k");
  });

  it("falls back to tags and merges releases from a previous home", async () => {
    const spec: DependencySpec = { name: "Input", source: { type: "codeberg", repo: "o/Input" }, previousSources: [{ type: "github", repo: "o/Input" }] };
    const { fetch } = fakeFetch(
      (req) => (req.url.startsWith("https://codeberg.org/api/v1/repos/o/Input/releases") ? json([githubRelease("10.5.0")]) : undefined),
      (req) => (req.url.startsWith("https://api.github.com/repos/o/Input/releases") ? json([]) : undefined),
      (req) => (req.url.startsWith("https://api.github.com/repos/o/Input/tags") ? json([{ name: "8.1.4" }, { name: "10.5.0" }, { name: "not-a-version" }]) : undefined),
    );
    const releases = await fetchReleases(spec, { fetch });
    assert.deepEqual(
      releases.map((r) => [r.version, r.source?.type ?? "main"]),
      [
        ["10.5.0", "main"],
        ["8.1.4", "github"],
      ],
    );
  });

  it("reads metadata.json out of a remote .yymps with range requests", async () => {
    const pkg = yymps("2.2.1", "2022.0.1.0", { "extensions/Steamworks/Steamworks_x64.dll": Buffer.alloc(200_000, 7) });
    const { fetch, requests } = fakeFetch((req) => (req.url === "https://dl/pkg.yymps" ? file(pkg, req) : undefined));
    const meta = await fetchPackageMetadata({ name: "pkg.yymps", url: "https://dl/pkg.yymps", size: pkg.length }, { fetch });
    assert.deepEqual(meta, { packageId: "pkg", version: "2.2.1", ideVersion: "2022.0.1.0" });
    assert.ok(requests.every((r) => r.headers.range), "only ranges were requested");
  });
});

describe("zip", () => {
  it("reads stored and deflated entries, with an archive comment", () => {
    const files = { "a.txt": "hello", "dir/b.bin": Buffer.from([1, 2, 3]) };
    for (const store of [false, true]) {
      const zip = new Zip(makeZip(files, { store, comment: "made by test" }));
      assert.deepEqual(
        zip.entries.map((e) => e.name),
        ["a.txt", "dir/b.bin"],
      );
      assert.equal(zip.read(zip.entries[0]).toString(), "hello");
      assert.deepEqual([...zip.read(zip.entries[1])], [1, 2, 3]);
    }
  });

  it("falls back to the whole file when the server ignores ranges", async () => {
    const buf = makeZip({ "metadata.json": "{}" });
    const { fetch, requests } = fakeFetch((req) => file(buf, req, true));
    const zip = new RemoteZip("https://x/p.yymps", buf.length, fetch);
    const [entry] = await zip.entries();
    assert.equal((await zip.read(entry)).toString(), "{}");
    assert.equal(requests.length, 1);
  });
});

const STEAMWORKS_YY = (version: string, functions = ["steam_initialised", "steam_get_app_id"]) => `{
  "resourceType": "GMExtension",
  "resourceVersion": "1.2",
  "name": "Steamworks",
  "extensionVersion": "${version}",
  "files": [
    {"resourceType":"GMExtensionFile","name":"","filename":"Steamworks_x64.dll","functions":[
      ${functions.map((f) => `{"resourceType":"GMExtensionFunction","name":"${f}","argCount":0,"args":[],"externalName":"${f}"},`).join("\n      ")}
    ],"constants":[]},
  ],
  "parent": {"name":"Extensions","path":"folders/Extensions.yy"},
}`;

function extensionProject(files: Record<string, string>, ideVersion = "2023.1.1.62"): string {
  const entries = Object.keys(files)
    .filter((f) => f.startsWith("extensions/") && f.endsWith(".yy"))
    .map((f) => `    {"id":{"name":"${f.split("/")[1]}","path":"${f}",},"order":0,},`);
  return writeProject(files, { extraEntries: entries, ideVersion });
}

describe("dependency detection", () => {
  it("finds extensions, version macros and generated scripts", () => {
    const dir = extensionProject({
      "extensions/Steamworks/Steamworks.yy": STEAMWORKS_YY("1.1.5"),
      "extensions/my_ext/my_ext.yy": `{"resourceType":"GMExtension","name":"my_ext","extensionVersion":"0.0.1","files":[]}`,
      "scripts/__scribble_constants/__scribble_constants.gml": `#macro SCRIBBLE_VERSION  "8.0.0"\n#macro SCRIBBLE_DATE "2023-01-01"`,
      "scripts/__SnapSystem/__SnapSystem.gml": `#macro __SNAP_VERSION  "5.0.0"`,
      "scripts/game_version/game_version.gml": `#macro GAME_VERSION "1.0.0"`,
      "scripts/GMLive/GMLive.gml": `// GMLive.gml (c) YellowAfterlife, 2017+\n// Generated at 2021-11-29 15:37:40 (10663ms) for v2.3.7+\nfunction live_init() {}`,
    });
    const result = scanProject(dir, { rules: ["gml/syntax-error"] });
    const deps = result.dependencies.map((d) => [d.kind, d.name, d.version ?? d.generatedAt, d.location.file, d.location.startLine]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    assert.deepEqual(deps, [
      ["generated", "GMLive", "2021-11-29", "scripts/GMLive/GMLive.gml", 2],
      ["extension", "my_ext", "0.0.1", "extensions/my_ext/my_ext.yy", 1],
      ["library", "Scribble", "8.0.0", "scripts/__scribble_constants/__scribble_constants.gml", 1],
      ["library", "SNAP", "5.0.0", "scripts/__SnapSystem/__SnapSystem.gml", 1],
      ["extension", "Steamworks", "1.1.5", "extensions/Steamworks/Steamworks.yy", 5],
    ]);
    assert.equal(result.dependencies.find((d) => d.name === "my_ext")?.spec, undefined);
    assert.equal(result.dependencies.find((d) => d.name === "GMLive")?.requires, "2.3.7");
    assert.equal(result.runtimes[0].version, "2023.1.1.62");
    assert.equal(result.runtimes[0].snippet, `"IDEVersion": "2023.1.1.62",`);
  });

  it("doesn't mistake a project's own extension for an official one with the same name", () => {
    const dir = extensionProject({
      "extensions/Steamworks/Steamworks.yy": STEAMWORKS_YY("1.0.0", ["my_steam_wrapper_init"]),
    });
    const [dep] = scanProject(dir, { rules: ["gml/syntax-error"] }).dependencies;
    assert.equal(dep.spec, undefined);
  });

  it("uses dependency sources from the config first", () => {
    const dir = extensionProject({ "scripts/mylib/mylib.gml": `#macro __MYLIB_VERSION "1.2.3"` });
    const config: Config = { dependencies: { sources: [{ name: "MyLib", macro: "MYLIB_VERSION", github: "me/mylib" }] } };
    const [dep] = scanProject(dir, { rules: ["gml/syntax-error"], config }).dependencies;
    assert.equal(dep.name, "MyLib");
    assert.deepEqual(dep.spec?.source, { type: "github", repo: "me/mylib" });
  });
});

/** A fake GitHub release API plus .yymps downloads for update checks. */
function releaseServer(repos: Record<string, { tag: string; ide?: string; notes?: string; prerelease?: boolean }[]>) {
  const packages = new Map<string, Buffer>();
  const routes = fakeFetch(
    (req) => {
      const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases/.exec(req.url);
      if (!m) return undefined;
      const list = repos[m[1]];
      if (!list) return json({ message: "Not Found" }, 404);
      return json(
        list.map((r) => {
          const assets = [];
          if (r.ide) {
            const url = `https://dl/${m[1]}/${r.tag}.yymps`;
            const buf = yymps(r.tag, r.ide);
            packages.set(url, buf);
            assets.push({ name: `pkg_${r.tag}.yymps`, size: buf.length, browser_download_url: url });
          }
          return githubRelease(r.tag, { assets, body: r.notes ?? "", prerelease: r.prerelease ?? false });
        }),
      );
    },
    (req) => {
      const buf = packages.get(req.url);
      return buf ? file(buf, req) : undefined;
    },
    (req) => (req.url.startsWith("https://marketplace.gamemaker.io/assets/5992") ? new Response("GMS2 - Version 1.0.56. Published August 21, 2021 GMS2.3 - Version 1.0.76. Published May 25, 2024") : undefined),
    (req) => (req.url.includes("Zeus-Runtime-LTS2026") ? new Response("<title>Version 2026.0.0.23</title>") : undefined),
    (req) => (req.url.includes("Zeus-Runtime-LTS") ? new Response("<title>Version 2022.0.3.99</title>") : undefined),
    (req) => (req.url.includes("Zeus-Runtime.rss") ? new Response("<title>Version 2024.14.4.268</title><title>Version 2023.1.2.95</title><title>Version 2023.1.1.90</title>") : undefined),
  );
  return routes;
}

describe("update check", () => {
  const libraryProject = (macros: Record<string, string>, ideVersion = "2023.1.1.62", config: Config = {}) => {
    const files: Record<string, string> = {};
    for (const [name, line] of Object.entries(macros)) files[`scripts/${name}/${name}.gml`] = line;
    return scanProject(extensionProject(files, ideVersion), { rules: ["gml/syntax-error"], config });
  };

  it("reports the newest release that supports the project's runtime", async () => {
    const result = libraryProject({ __scribble_constants: `#macro SCRIBBLE_VERSION "8.0.0"` });
    const tags = ["9.7.3", "9.5.0", "9.0.0", "8.8.4", "8.7.0", "8.1.0", "8.0.0", "7.0.0"];
    const { fetch } = releaseServer({ "JujuAdams/Scribble": tags.map((tag) => ({ tag, ide: tag.startsWith("9") ? "2023.4.0.84" : "2022.0.0.19" })) });
    const updates = await checkUpdates(result, { http: { fetch } });
    const [report] = updates.reports;
    assert.equal(report.status, "outdated");
    assert.equal(report.update?.release.version, "8.8.4");
    assert.equal(report.update?.updateType, "minor");
    assert.equal(report.latest?.release.version, "9.7.3");
    assert.equal(report.latest?.requirement?.minimum, "2023.4.0");
    assert.equal(updates.findings.length, 1);
    const [f] = updates.findings;
    assert.equal(f.ruleId, "gml/outdated-dependency");
    assert.equal(f.severity, "note");
    assert.equal(f.location.file, "scripts/__scribble_constants/__scribble_constants.gml");
    assert.match(f.message, /^Scribble 8\.0\.0 can be updated to 8\.8\.4 .* from JujuAdams\/Scribble on GitHub\. 9\.7\.3 is out too, but needs GameMaker 2023\.4\.0 or later\.$/);
  });

  it("with runtime updates on, reports updates that need a newer runtime", async () => {
    const result = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.8.4"` }, "2023.1.1.62", { dependencies: { runtimeUpdates: true } });
    const { fetch } = releaseServer({ "JujuAdams/Scribble": [{ tag: "9.7.3", ide: "2023.4.0.84" }] });
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].update?.needsRuntime, true);
    assert.match(updates.findings.find((f) => f.ruleId === "gml/outdated-dependency")!.message, /It needs GameMaker 2023\.4\.0 or later; this project targets 2023\.1\.1\.62\.$/);
    const runtime = updates.findings.find((f) => f.ruleId === "gml/runtime-update")!;
    assert.equal(runtime.message, "Newer GameMaker runtimes are available: 2023.1.2.95 (an update to this release), 2026.0.0.23 (LTS) and 2024.14.4.268. This project targets 2023.1.1.62.");
    assert.equal(runtime.location.file, "TestGame.yyp");
  });

  it("with runtime updates on, still prefers a release that works with the current runtime", async () => {
    const result = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.0.0"` }, "2023.1.1.62", { dependencies: { runtimeUpdates: true } });
    const { fetch } = releaseServer({ "JujuAdams/Scribble": [{ tag: "9.7.3", ide: "2023.4.0.84" }, { tag: "8.8.4", ide: "2022.0.0.19" }] });
    const [report] = (await checkUpdates(result, { http: { fetch } })).reports;
    assert.equal(report.update?.release.version, "8.8.4");
    assert.equal(report.update?.needsRuntime, undefined);
    assert.equal(report.latest?.release.version, "9.7.3");
  });

  it("without runtime updates, newer releases that need a newer runtime aren't alerts", async () => {
    const result = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.8.4"` });
    const { fetch } = releaseServer({ "JujuAdams/Scribble": [{ tag: "9.7.3", ide: "2023.4.0.84" }] });
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].status, "needs-runtime");
    assert.deepEqual(updates.findings, []);
  });

  it("doesn't alert on releases it can't check against the runtime", async () => {
    const result = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.8.4"` });
    const { fetch } = releaseServer({ "JujuAdams/Scribble": [{ tag: "9.0.0" }] });
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].status, "unverified");
    assert.deepEqual(updates.findings, []);
  });

  it("uses compatibility stated in release notes", async () => {
    const result = libraryProject({ s: `#macro SNAP_VERSION "5.0.0"` });
    const { fetch } = releaseServer({ "JujuAdams/SNAP": [{ tag: "6.0.0", notes: "Requires GameMaker 2022.0.1 or later." }] });
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].update?.release.version, "6.0.0");
  });

  it("skips pre-releases and ignored versions", async () => {
    const config: Config = { dependencies: { ignore: [{ name: "scribble", updateTypes: ["major"] }, { name: "Scribble", versions: ["8.8.x"] }] } };
    const result = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.0.0"` }, "2023.1.1.62", config);
    const { fetch } = releaseServer({
      "JujuAdams/Scribble": [
        { tag: "9.0.0", ide: "2022.0.0.1" },
        { tag: "8.9.0-beta.1", ide: "2022.0.0.1", prerelease: true },
        { tag: "8.8.4", ide: "2022.0.0.1" },
        { tag: "8.7.0", ide: "2022.0.0.1" },
      ],
    });
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].update?.release.version, "8.7.0");
  });

  it("can ignore a dependency entirely", async () => {
    const result = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.0.0"` }, "2023.1.1.62", { dependencies: { ignore: ["Scribble"] } });
    const { fetch, requests } = releaseServer({});
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].status, "ignored");
    assert.equal(requests.length, 0);
  });

  it("checks GMLive's generated date against the Marketplace", async () => {
    const result = libraryProject({ GMLive: `// Generated at 2021-11-29 15:37:40 (10663ms) for v2.3.7+` });
    const { fetch } = releaseServer({});
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].update?.release.version, "1.0.76");
    assert.equal(updates.findings[0].message, "GMLive here was generated on 2021-11-29; version 1.0.76 (published 2024-05-25) is on the GameMaker Marketplace.");

    const recent = libraryProject({ GMLive: `// Generated at 2024-05-20 10:00:00 (10663ms) for v2.3.7+` });
    assert.equal((await checkUpdates(recent, { http: { fetch } })).reports[0].status, "up-to-date");
  });

  it("reports lookups that fail instead of throwing", async () => {
    const result = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.0.0"` });
    const { fetch } = fakeFetch(() => new Response("boom", { status: 502 }));
    const updates = await checkUpdates(result, { http: { fetch } });
    assert.equal(updates.reports[0].status, "error");
    assert.match(updates.errors[0], /^Scribble: HTTP 502/);
  });

  it("honours suppression comments on version macros and rule settings", async () => {
    const tags = [{ tag: "8.8.4", ide: "2022.0.0.19" }];
    const suppressed = libraryProject({ s: `// gmlscan-ignore-next-line gml/outdated-dependency\n#macro SCRIBBLE_VERSION "8.0.0"` });
    assert.deepEqual((await checkUpdates(suppressed, { http: { fetch: releaseServer({ "JujuAdams/Scribble": tags }).fetch } })).findings, []);
    const off = libraryProject({ s: `#macro SCRIBBLE_VERSION "8.0.0"` }, "2023.1.1.62", { rules: { "gml/outdated-dependency": "off" } });
    const updates = await checkUpdates(off, { http: { fetch: releaseServer({ "JujuAdams/Scribble": tags }).fetch } });
    assert.deepEqual(updates.findings, []);
    assert.equal(updates.reports[0].status, "outdated");
  });

  it("suggests newer runtimes by release line", () => {
    const versions = ["2026.0.0.23", "2024.14.4.268", "2023.1.1.90", "2022.0.3.99"];
    const target = (version: string, explicit = false) => ({ project: undefined as never, version, explicit });
    assert.deepEqual(
      newerRuntimes(target("2022.0.3.85", true), versions).map((a) => `${a.version}:${a.kind}`),
      ["2022.0.3.99:patch", "2026.0.0.23:lts", "2024.14.4.268:monthly"],
    );
    // An IDEVersion's build number doesn't count.
    assert.deepEqual(newerRuntimes(target("2026.0.0.20"), versions), []);
  });
});

describe("dependencies config", () => {
  it("validates entries", () => {
    const bad = (dependencies: unknown) => {
      const dir = writeProject({ ".gmlscan.json": JSON.stringify({ dependencies }) }, { yyp: false });
      assert.throws(() => loadConfig(dir), ConfigError);
    };
    bad({ autoUpdate: "yes" });
    bad({ ignore: [{ versions: ["1.x"] }] });
    bad({ ignore: [{ name: "x", updateTypes: ["huge"] }] });
    bad({ sources: [{ name: "x", github: "me/x" }] });
    bad({ sources: [{ name: "x", macro: "X", github: "me/x", codeberg: "me/x" }] });
    bad({ sources: [{ name: "x", macro: "X", github: "https://github.com/me/x" }] });
    bad({ sources: [{ name: "x", extension: "X", github: "me/x", asset: "(" }] });
  });

  it("defaults to auto-updates on and runtime updates off", () => {
    const d = resolveConfig({}).dependencies;
    assert.equal(d.autoUpdate, true);
    assert.equal(d.runtimeUpdates, false);
    assert.equal(d.checkUpdates, undefined);
    assert.equal(resolveConfig({ dependencies: { autoUpdate: false } }).dependencies.autoUpdate, false);
  });
});
