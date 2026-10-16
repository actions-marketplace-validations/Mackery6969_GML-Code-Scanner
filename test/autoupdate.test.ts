import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { branchName, keepParent, openUpdatePullRequests, planExtensionUpdate, updatableExtensions, type AutoUpdateOptions } from "../src/deps/autoupdate.ts";
import type { DependencyReport } from "../src/deps/updates.ts";
import { fakeFetch, file, json, makeZip, type FakeRequest } from "./deps-helpers.ts";
import { scanProject, writeProject } from "./helpers.ts";

const yy = (version: string, functions: string[], parent: string) => `{
  "resourceType": "GMExtension",
  "name": "Steamworks",
  "extensionVersion": "${version}",
  "files": [
    {"resourceType":"GMExtensionFile","filename":"Steamworks_x64.dll","functions":[
      ${functions.map((f) => `{"name":"${f}","argCount":0,"args":[],"externalName":"${f}"},`).join("\n      ")}
    ],"constants":[]},
  ],
  "parent": ${parent},
}`;

const INSTALLED_PARENT = `{"name":"Steam","path":"folders/Libraries/Steam.yy",}`;
const INSTALLED_YY = yy("1.1.5", ["steam_initialised", "steam_old_call"], INSTALLED_PARENT);
const NEW_YY = yy("2.2.1", ["steam_initialised", "steam_new_call"], `{"name":"Extensions","path":"folders/Extensions.yy",}`);
const DLL = Buffer.alloc(64, 1);

function installedReport(extra: Record<string, string> = {}): DependencyReport {
  const dir = writeProject(
    {
      "extensions/Steamworks/Steamworks.yy": INSTALLED_YY,
      "objects/obj_steam/Create_0.gml": "if (steam_initialised()) steam_old_call();",
      ...extra,
    },
    { extraEntries: [`    {"id":{"name":"Steamworks","path":"extensions/Steamworks/Steamworks.yy",},"order":0,},`] },
  );
  const result = scanProject(dir, { rules: ["gml/syntax-error"] });
  const dependency = result.dependencies.find((d) => d.name === "Steamworks")!;
  assert.ok(dependency.spec, "matched the registry");
  return {
    dependency,
    status: "outdated",
    runtime: "2023.1.1.62",
    update: {
      release: {
        version: "2.2.1",
        prerelease: false,
        url: "https://github.com/YoYoGames/GMEXT-Steamworks/releases/tag/2.2.1",
        notes: "Fixed @someone's bug (#12).\n```js\ncode\n```",
        assets: [],
        packageAsset: { name: "Steamworks.Ext.v2.2.1.yymps", url: "https://dl/steamworks.yymps", size: 0 },
      },
      requirement: { minimum: "2023.1", basis: ["release notes: \"GM 2023.1 and future releases\""] },
      compatible: true,
      updateType: "major",
    },
  };
}

const PACKAGE = makeZip({
  "metadata.json": "{}",
  "Steamworks.yyp": "{}",
  "extensions/Steamworks/Steamworks.yy": NEW_YY,
  "extensions/Steamworks/Steamworks_x64.dll": DLL,
  "extensions/Steamworks/docs/readme.txt": "docs",
  "extensions/Steamworks/Steamworks.ext": "",
  "objects/Obj_Steam/Create_0.gml": "demo",
  "rooms/rm_demo/rm_demo.yy": "{}",
});

describe("extension update plan", () => {
  it("takes only the extension folder and keeps its place in the asset browser", () => {
    const report = installedReport();
    const plan = planExtensionUpdate(report.dependency, PACKAGE, INSTALLED_YY);
    assert.deepEqual(plan.files.map((f) => f.path).sort(), ["Steamworks.ext", "Steamworks.yy", "Steamworks_x64.dll", "docs/readme.txt"]);
    const newYy = plan.files.find((f) => f.path === "Steamworks.yy")!.content.toString();
    assert.match(newYy, /"extensionVersion": "2\.2\.1"/);
    assert.ok(newYy.includes(`"parent": ${INSTALLED_PARENT}`));
    assert.deepEqual(plan.removedFunctions, ["steam_old_call"]);
    assert.equal(plan.otherPackageFiles, 2);
  });

  it("refuses packages without the extension or with unsafe paths", () => {
    const report = installedReport();
    assert.throws(() => planExtensionUpdate(report.dependency, makeZip({ "extensions/Other/Other.yy": "{}" }), undefined), /no extension named Steamworks/);
    assert.throws(() => planExtensionUpdate(report.dependency, makeZip({ "extensions/Steamworks/Steamworks.yy": NEW_YY, "extensions/Steamworks/../../evil.gml": "x" }), undefined), /unsafe path/);
  });

  it("keeps the installed parent only when both files have one", () => {
    assert.equal(keepParent(`{"parent":{"name":"A","path":"a"},"x":1}`, `{"parent":{"name":"B","path":"b"}}`), `{"parent":{"name":"B","path":"b"},"x":1}`);
    assert.equal(keepParent(`{"x":1}`, `{"parent":{"name":"B","path":"b"}}`), `{"x":1}`);
  });

  it("only updates extensions with a package and no runtime upgrade", () => {
    const report = installedReport();
    assert.equal(updatableExtensions([report]).length, 1);
    assert.equal(updatableExtensions([{ ...report, update: { ...report.update!, needsRuntime: true } }]).length, 0);
    assert.equal(updatableExtensions([{ ...report, status: "needs-runtime" }]).length, 0);
    assert.equal(branchName(report.dependency, "2.2.1"), "gml-code-scanner/Steamworks-2.2.1");
  });
});

const gitSha = (content: Buffer | string) => {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
};

const API = "https://api.github.test";

function fakeGitHub(options: { existingPulls?: unknown[]; openPulls?: unknown[]; createPull?: (req: FakeRequest) => Response } = {}) {
  let blobs = 0;
  return fakeFetch(
    (req) => (req.url === "https://dl/steamworks.yymps" ? file(PACKAGE, req) : undefined),
    (req) => {
      if (!req.url.startsWith(`${API}/repos/me/game/`)) return undefined;
      const path = req.url.slice(`${API}/repos/me/game/`.length);
      const route = `${req.method} ${path}`;
      if (route === "GET git/ref/heads/main") return json({ object: { sha: "base" } });
      if (route === "GET git/commits/base") return json({ tree: { sha: "root" } });
      if (route.startsWith("GET pulls?state=all&head=")) return json(options.existingPulls ?? []);
      if (route === "GET git/trees/root") return json({ tree: [{ path: "extensions", type: "tree", sha: "t-ext", mode: "040000" }] });
      if (route === "GET git/trees/t-ext") return json({ tree: [{ path: "Steamworks", type: "tree", sha: "t-steam", mode: "040000" }] });
      if (route === "GET git/trees/t-steam?recursive=1")
        return json({
          tree: [
            { path: "Steamworks.yy", type: "blob", sha: "installed-yy", mode: "100644" },
            { path: "Steamworks_x64.dll", type: "blob", sha: gitSha(DLL), mode: "100644" },
            { path: "libsteam_api.dylib", type: "blob", sha: "old-dylib", mode: "100644", size: 500 },
            { path: "Steamworks.ext", type: "blob", sha: "old-ext", mode: "100644", size: 10 },
          ],
        });
      if (route === "GET git/blobs/installed-yy") return json({ content: Buffer.from(INSTALLED_YY).toString("base64"), encoding: "base64" });
      if (route === "POST git/blobs") return json({ sha: `blob-${++blobs}` }, 201);
      if (route === "POST git/trees") return json({ sha: "tree-2" }, 201);
      if (route === "POST git/commits") return json({ sha: "commit-2" }, 201);
      if (route === "POST git/refs") return json({ ref: "x" }, 201);
      if (route === "POST pulls") return options.createPull?.(req) ?? json({ number: 7, html_url: "https://github.com/me/game/pull/7" }, 201);
      if (route.startsWith("GET pulls?state=open")) return json(options.openPulls ?? []);
      if (/^(POST issues\/\d+\/(labels|comments)|PATCH pulls\/\d+|DELETE git\/refs\/heads\/)/.test(route)) return json({});
      return undefined;
    },
  );
}

function autoOptions(fetch: AutoUpdateOptions["http"]["fetch"], dir: string): AutoUpdateOptions {
  return { token: "t0k", apiUrl: API, serverUrl: "https://github.com", repository: "me/game", baseBranch: "main", workspaceRoot: dir, scanRoot: dir, http: { fetch }, log: () => {} };
}

describe("update pull requests", () => {
  it("commits the new extension through the Git Data API and opens a pull request", async () => {
    const report = installedReport();
    report.update!.release.packageAsset!.size = PACKAGE.length;
    const gh = fakeGitHub({ openPulls: [{ number: 3, head: { ref: "gml-code-scanner/Steamworks-2.0.0" } }, { number: 4, head: { ref: "gml-code-scanner/Steamworks-Extra-1.0.0" } }, { number: 5, head: { ref: "gml-code-scanner/Steamworks-3.0.0" } }] });
    const result = await openUpdatePullRequests([report], autoOptions(gh.fetch, report.dependency.project.rootAbs));
    assert.deepEqual(result.opened, [{ dependency: "Steamworks", from: "1.1.5", to: "2.2.1", number: 7, url: "https://github.com/me/game/pull/7" }]);
    assert.equal(result.blocked, undefined);

    const tree = gh.requests.find((r) => r.method === "POST" && r.url.endsWith("/git/trees"))!.body as { base_tree: string; tree: { path: string; sha: string | null }[] };
    assert.equal(tree.base_tree, "root");
    assert.deepEqual(
      tree.tree.map((e) => [e.path, e.sha === null ? "delete" : "write"]).sort(),
      [
        ["extensions/Steamworks/Steamworks.ext", "write"],
        ["extensions/Steamworks/Steamworks.yy", "write"],
        ["extensions/Steamworks/docs/readme.txt", "write"],
        ["extensions/Steamworks/libsteam_api.dylib", "delete"],
      ],
      "the unchanged DLL isn't re-uploaded",
    );
    const commit = gh.requests.find((r) => r.url.endsWith("/git/commits"))!.body as { parents: string[]; message: string };
    assert.deepEqual(commit.parents, ["base"]);
    assert.match(commit.message, /^deps: bump Steamworks extension from 1\.1\.5 to 2\.2\.1/);
    assert.deepEqual(gh.requests.find((r) => r.url.endsWith("/git/refs"))!.body, { ref: "refs/heads/gml-code-scanner/Steamworks-2.2.1", sha: "commit-2" });

    const pr = gh.requests.find((r) => r.method === "POST" && r.url.endsWith("/pulls"))!.body as { title: string; head: string; base: string; body: string };
    assert.equal(pr.title, "Bump Steamworks extension from 1.1.5 to 2.2.1");
    assert.equal(pr.head, "gml-code-scanner/Steamworks-2.2.1");
    assert.equal(pr.base, "main");
    assert.match(pr.body, /\| Update type \| major: check the release notes for breaking changes \|/);
    assert.match(pr.body, /Needs GameMaker 2023\.1 or later .* This project targets 2023\.1\.1\.62\./);
    assert.match(pr.body, /`steam_old_call` in \[objects\/obj_steam\/Create_0\.gml:1\]/);
    assert.match(pr.body, /2 other files .* aren't imported/);
    assert.match(pr.body, /empty in the package: `Steamworks\.ext`\./);
    // Release notes are fenced, so they can't @mention people or cross-reference upstream issues.
    assert.match(pr.body, /````text\nFixed @someone's bug \(#12\)\.\n```js\ncode\n```\n````/);

    // The older pull request for this extension is closed; other extensions and newer ones are left alone.
    assert.ok(gh.requests.some((r) => r.method === "PATCH" && r.url.endsWith("/pulls/3")));
    assert.ok(!gh.requests.some((r) => r.method === "PATCH" && /\/pulls\/[45]$/.test(r.url)));
  });

  it("doesn't reopen a version whose pull request was closed", async () => {
    const report = installedReport();
    const gh = fakeGitHub({ existingPulls: [{ number: 6, state: "closed", merged_at: null, html_url: "u" }] });
    const result = await openUpdatePullRequests([report], autoOptions(gh.fetch, report.dependency.project.rootAbs));
    assert.deepEqual(result.opened, []);
    assert.match(result.skipped[0].reason, /#6 was closed without merging/);
    assert.ok(!gh.requests.some((r) => r.method === "POST"));
  });

  it("explains when GitHub Actions may not create pull requests, and removes the branch", async () => {
    const report = installedReport();
    report.update!.release.packageAsset!.size = PACKAGE.length;
    const gh = fakeGitHub({ createPull: () => json({ message: "GitHub Actions is not permitted to create or approve pull requests." }, 403) });
    const result = await openUpdatePullRequests([report], autoOptions(gh.fetch, report.dependency.project.rootAbs));
    assert.match(result.blocked ?? "", /Allow GitHub Actions to create and approve pull requests/);
    assert.ok(gh.requests.some((r) => r.method === "DELETE" && r.url.endsWith("/git/refs/heads/gml-code-scanner/Steamworks-2.2.1")));
  });
});
