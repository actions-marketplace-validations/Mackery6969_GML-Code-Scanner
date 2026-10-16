# GML Code Scanner

Static analysis and security scanning for **GameMaker** (GML) projects, in the spirit of CodeQL.

It reads your whole project (the `.yyp`, objects, events, scripts, rooms and extensions), not just single files, so it can find problems that only show up across files. Results appear in GitHub's **Security → Code scanning** tab, as annotations on pull requests, and in the job summary.

- **Bugs that crash your game:** undefined functions and variables, missing assets, `"Score: " + 10`, locals used inside callbacks (GML has no closures), wrong argument counts, infinite loops.
- **Security:** taint tracking follows network, HTTP and Steam data (and optionally file and user input) through variables, structs and function calls into `script_execute`, file paths, `variable_instance_set`, shell extensions and more. Each finding shows the full source-to-sink path. It also finds hard-coded API keys, tokens and webhooks in code, `options/` and `datafiles/`.
- **GameMaker-specific mistakes:** alarms reset every step, drawing outside Draw events, surfaces used without `surface_exists`, leaked `ds_*`, surfaces and buffers, unbalanced `surface_set_target`/`shader_set`/`ini_open`.
- **Performance:** per-frame disk I/O, GPU readbacks, uncached `shader_get_uniform`/`layer_get_id`, O(n²) string loops, `instance_number(obj) > 0`.
- **Project integrity:** resources registered twice in the `.yyp` (which crashes the IDE), resources missing from disk or from the `.yyp`, event files the object doesn't list (never run), unused objects and functions, duplicate functions, macros and enums.
- **Dependency updates:** outdated extensions (YoYo Games' official ones such as Steamworks, FMOD, AdMob and Firebase) and libraries copied into your scripts (Scribble, Input, SNAP, Chatterbox...), but only updates that support your project's GameMaker version. Like Dependabot, it can open pull requests that update extensions.

It needs no GameMaker install or licence: it runs in a couple of seconds on an 8,000-file project, on any runner.

## Quick start

Add one file to your game's repository, `.github/workflows/gml-code-scanner.yml`:

```yaml
name: GML Code Scanner
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "30 4 * * 1"   # weekly, to pick up new rules and dependency updates

permissions:
  contents: write          # read the code, and push branches for extension update pull requests
  security-events: write   # lets the scanner publish results to the Security tab
  pull-requests: write     # open extension update pull requests

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Mackery6969/GML-Code-Scanner@v1
```

That's all. Like CodeQL's analysis step, the action uploads its results to **Security → Code scanning** itself, adds annotations to pull requests, and writes a summary to the job page. If your GameMaker project isn't at the repository root, add `with: path: MyGame`.

The two `write` permissions are only for [extension update pull requests](#dependency-updates). Without them, use `contents: read` and add `with: auto-update: false`.

- **Public repositories:** code scanning is free, and results show up in the Security tab after the first run.
- **Private repositories without GitHub Code Security:** the upload is skipped with a short notice, and you still get pull request annotations and the job summary. Add `with: upload: false` to silence the notice. On pull requests, only findings on the lines the pull request changes are annotated and can fail the job (see `pr-scope`), so existing issues don't bury new ones.
- **Pull requests from forks** can't upload (GitHub gives them a read-only token). They still get annotations.

Want the job to fail on findings? It already does for `error`-level findings. Set `fail-on: warning` to be stricter, or `fail-on: none` to only report.

### One-click setup for your organization

To put GML Code Scanner on your organization's **Actions → New workflow** page, so any repository can add it with **Configure** and get the pre-built workflow, copy the template in [`templates/`](templates) into your organization's `.github` repository.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Folder to scan: a project folder (with a `.yyp`) or a repository containing one or more projects. |
| `config` | | Config file. Defaults to `.gmlscan.json` in the scanned folder. |
| `suite` | `default` | `default`, `security-extended`, `security-and-quality` or `all`. |
| `threat-models` | `remote` | Untrusted data to track: `remote` (network/HTTP/Steam) and/or `local` (files, INI, clipboard, command line, `keyboard_string`). |
| `runtime` | from `.yyp` | Target GameMaker runtime, e.g. `2023.1.1.81`. |
| `runtime-dir` | | An installed runtime to check against, such as the `runtime-dir` output of `bscotch/igor-setup`. See [GameMaker runtime data](#gamemaker-runtime-data). |
| `upload` | `auto` | Upload to code scanning: `auto` (warn if unavailable), `true` (fail if the upload fails), `false`. |
| `token` | `github.token` | Token for the upload (needs `security-events: write`). |
| `wait-for-processing` | `true` | Wait for GitHub to process the upload, report processing errors, and leave out findings whose alerts are dismissed. |
| `sarif-file` | `gml-code-scanner.sarif` | Where to write the SARIF report (also usable as an artifact). |
| `category` | `gml-code-scanner` | SARIF category, used to tell several analyses of the same commit apart (for example, several games in one repo). |
| `fail-on` | `error` | Fail the step on findings at this level or above: `error`, `warning`, `note`, `none`. |
| `pr-scope` | `changed-lines` | On pull requests, which findings to annotate and fail on: `changed-lines`, `changed-files` or `all`. The SARIF always has every finding. Needs `pull-requests: read`. |
| `annotations` | `true` | Add inline annotations to the pull request. |
| `max-annotations` | `50` | Maximum annotations per run. |
| `step-summary` | `true` | Write a findings table to the job summary. |
| `check-updates` | `true` | Look for newer versions of extensions and libraries that support the project's GameMaker version. |
| `runtime-updates` | `false` | Also report newer GameMaker runtimes, and dependency updates that need one. |
| `auto-update` | `true` | Open pull requests that update extensions, on runs on the default branch. Needs `contents: write` and `pull-requests: write`. |

The last three default to the `dependencies` settings in `.gmlscan.json`, when it has them.

**Outputs:** `sarif-file`, `sarif-id`, `findings`, `errors`, `warnings`, `notes` (on pull requests these count only findings within `pr-scope`, and never findings with dismissed alerts), `total-findings`, `dismissed`, `outdated-dependencies` (extensions and libraries with a compatible update), and `update-pull-requests` (URLs of the update pull requests this run opened).

### Big repositories and private repositories

GameMaker repositories are mostly sprites and audio, which the scanner never reads. A blobless, sparse checkout fetches only code and project metadata, which is much faster for large games. For a private repository without code scanning, you can also keep the SARIF report as a build artifact and open it in VS Code with the SARIF Viewer:

```yaml
permissions:
  contents: read
  pull-requests: read   # for pr-scope

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          filter: blob:none
          sparse-checkout-cone-mode: false
          sparse-checkout: |
            /*.yyp
            /.gmlscan.json
            **/*.yy
            **/*.gml
            /datafiles/**/*.ini
            /datafiles/**/*.json
            /datafiles/**/*.txt
      - uses: Mackery6969/GML-Code-Scanner@v1
        id: scan
        with:
          upload: false
          # Pull requests fail on new errors in the lines they change; pushes only report.
          fail-on: ${{ github.event_name == 'pull_request' && 'error' || 'none' }}
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: gml-code-scanner-sarif
          path: ${{ steps.scan.outputs.sarif-file }}
```

## Rule suites

Like CodeQL, rules are grouped into suites:

| Suite | What runs |
| --- | --- |
| `default` | High-precision bugs, security issues, project-integrity checks and the most important performance problems. |
| `security-extended` | `default` plus lower-precision security rules (untrusted URLs, weak password hashes, predictable tokens, secrets in logs, unsafe deserialization). |
| `security-and-quality` | Everything, including maintainability and style suggestions (unused locals, legacy syntax, missing `event_inherited()`, JSDoc mismatches...). |

See **[docs/rules.md](docs/rules.md)** for every rule, with examples and fixes.

## Dependency updates

The scanner finds what your game depends on and checks it for updates:

| What | How it's recognised | Where updates come from |
| --- | --- | --- |
| YoYo Games' official extensions (46, including Steamworks, FMOD, AdMob, the Firebase family, GOG, Epic Online Services and Discord) | Extension name, plus the functions it defines, so your own extension with the same name isn't mistaken for it. The version is `extensionVersion` in its `.yy`. | GitHub releases of `YoYoGames/GMEXT-*` |
| Libraries copied into your scripts: Scribble, Input, SNAP, Chatterbox, Vinyl, Bulb, Dynamo, Coroutines, iota, Collage | Their version macro, e.g. `#macro SCRIBBLE_VERSION "9.7.3"` | GitHub or Codeberg releases |
| NekoPresence | Extension name and functions | GitHub releases |
| GMLive | The date in its generated script's header | GameMaker Marketplace |
| Your own libraries and extensions | Whatever you configure (see below) | GitHub, Codeberg or the Marketplace |

**Only updates that work with your GameMaker version count.** For each newer release, the scanner reads which IDE its `.yymps` package was exported from (GameMaker can't import packages from a newer IDE), plus any minimum stated in the release notes, such as "GM 2023.1 and future releases". It reports the newest release your project's runtime (`IDEVersion` in the `.yyp`, or `runtime` in the config) can use, and mentions newer ones that need a newer GameMaker. Releases it can't verify are listed in the job summary but don't raise an alert.

Each update is a `gml/outdated-dependency` note on the version line. The alert closes by itself once you update. With `runtime-updates: true`, newer GameMaker runtimes are reported too (`gml/runtime-update`), along with dependency updates that need one.

### Update pull requests

When the action runs on your default branch (a push, the weekly schedule or a manual run), it opens a pull request for each extension update, like Dependabot:

- Only the extension's folder (`extensions/<Name>/`) is replaced with the one from the release's `.yymps`. Extension option values (`options/extensions/`) are left as they are, the extension stays in the same folder of the asset browser, and the package's demo objects and rooms aren't imported.
- The pull request lists the extension functions your game calls that the new version removes, with links to each call.
- Updates that need a newer GameMaker don't get pull requests. Libraries copied into scripts don't either, because they usually come with config scripts you've edited.
- Close a pull request to skip that version; it won't be opened again. A newer version closes the pull request for the older one. An update whose alert you dismissed in the Security tab doesn't get a pull request.

The job needs `contents: write` and `pull-requests: write`. GitHub also has to allow Actions to open pull requests: turn on **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Pull requests opened with the workflow's own token don't trigger other workflows. To run your CI on them, pass a fine-grained personal access token or a GitHub App token as `token`.

### Settings

```jsonc
"dependencies": {
  "checkUpdates": true,       // the action checks by default; the command line needs --check-updates unless this is true
  "runtimeUpdates": false,    // also report newer GameMaker runtimes
  "autoUpdate": true,         // open update pull requests for extensions
  "ignore": [
    "GMLive",                                           // never report this one
    { "name": "Steamworks", "updateTypes": ["major"] }, // only minor and patch updates
    { "name": "Scribble", "versions": ["10.x"] }        // skip these versions
  ],
  "sources": [
    // Your own library: #macro MYLIB_VERSION "1.2.3", released on GitHub
    { "name": "MyLib", "macro": "MYLIB_VERSION", "github": "me/mylib" },
    // An extension released as a .yymps on Codeberg
    { "name": "MyExt", "extension": "MyExt", "codeberg": "me/myext", "asset": "MyExt.*\\.yymps" }
  ]
}
```

Extensions the scanner doesn't know are listed in the job summary as *not tracked*. Add them under `sources` to check them.

### Keeping the scanner itself up to date

Dependabot can keep `Mackery6969/GML-Code-Scanner@v…` (and your other actions) current. Add `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

## Configuration

Create `.gmlscan.json` in your project folder (`npx github:Mackery6969/GML-Code-Scanner#v1 --init` writes a commented starter file). Comments and trailing commas are allowed.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Mackery6969/GML-Code-Scanner/main/gmlscan.schema.json",
  "suite": "default",
  "rules": {
    "gml/unused-function": "off",       // or "error" | "warning" | "note"
    "gml/wrong-argument-count": "error"
  },
  "ignore": ["extensions/**", "scripts/vendor_*/**"],   // no findings reported here (still read for definitions)
  "threatModels": ["remote", "local"],
  "globalPrefixes": ["g_"],              // treat g_* names as declared globals
  "runtime": "2023.1.1.81",
  "dependencies": { "autoUpdate": false } // see "Dependency updates"
}
```

### Ignoring files

Put a `.gmlscanignore` file in the folder you scan, or in any folder above it up to the repository root. It works like `.gitignore`:

```gitignore
# third-party code
scripts/vendor_*/
extensions/

# but keep checking this one
!scripts/vendor_ourfork/

# only at the top of the folder this file is in
/datafiles/generated/
```

- A pattern without a `/` (apart from a trailing one) matches at any depth; one with a `/` is relative to the file's own folder.
- A trailing `/` matches folders only. `*`, `?` and `**` work as in `.gitignore`.
- `!` brings back something an earlier line ignored, and the last matching line wins.
- Files further down override files further up, and the `"ignore"` list in `.gmlscan.json` is applied last.

Findings in ignored files aren't reported, but files in a `.yyp` project are still read, so the functions and assets they define stay known and don't show up as undefined elsewhere. Dependency update alerts are the exception: they still appear for libraries and extensions in ignored folders. Use `dependencies.ignore` to silence those.

### Suppressing findings

```gml
// gmlscan-ignore-next-line gml/resource-leak -- freed by obj_controller
list = ds_list_create();

draw_text(x, y, text); // gmlscan-ignore-line

// gmlscan-ignore-file gml/unused-object
```

Leave out the rule ID to suppress every rule.

On GitHub you can also dismiss an alert in the Security tab as "won't fix" or "false positive". The dismissal sticks to the flagged line's text, so it survives code moving up or down and reformatting, but editing that line, or moving or renaming the file, raises a new alert. Once GitHub has processed the upload, the action leaves dismissed findings out of its annotations, job summary and `fail-on` check too. Comments work everywhere, including runs without code scanning, so prefer them for permanent exceptions.

### Custom rules

Write your own checks as GML patterns: `$NAME` matches any expression, and `...` matches any number of arguments or statements.

```jsonc
"patterns": [
  {
    "id": "no-debug-overlay",
    "pattern": "show_debug_overlay(true)",
    "message": "Remove the debug overlay before release.",
    "severity": "error"
  },
  {
    "id": "no-direct-enemy-spawn",
    "pattern": "instance_create_layer(..., $OBJ)",
    "where": { "$OBJ": "^obj_enemy" },
    "message": "Spawn $OBJ through scr_spawn_enemy() so it is registered with the wave manager.",
    "events": ["Step"]
  }
]
```

In patterns, write hex numbers as `0xFF`, because `$FF` would be read as a metavariable.

### Taint models for your own extensions

If your game uses a networking or shell extension, tell the scanner about it:

```jsonc
"taint": {
  "sources":    [{ "function": "net_receive_string", "kind": "remote" }],
  "sinks":      [{ "function": "my_dll_exec", "arguments": [0], "kind": "command-injection" }],
  "sanitizers": ["net_validate_command"]
}
```

Sink kinds: `code-injection`, `path-injection`, `command-injection`, `variable-injection`, `url-redirect`, `unsafe-deserialization`.

## Command line

The same scanner runs locally. It needs only Node.js 20+ (no npm packages or GameMaker install):

```sh
npx github:Mackery6969/GML-Code-Scanner#v1 path/to/project            # console report
npx github:Mackery6969/GML-Code-Scanner#v1 . --suite all --paths       # everything, with data-flow paths
npx github:Mackery6969/GML-Code-Scanner#v1 . --format sarif -o out.sarif
npx github:Mackery6969/GML-Code-Scanner#v1 . --check-updates          # also look for dependency updates
npx github:Mackery6969/GML-Code-Scanner#v1 --list-rules
```

It exits with 1 when findings at or above `--fail-on` (default `error`) exist, which makes it usable as a pre-commit hook. In VS Code, open the SARIF file with Microsoft's [SARIF Viewer](https://marketplace.visualstudio.com/items?itemName=MS-SarifVSCode.sarif-viewer) to jump through findings and data-flow paths.

## Working with GitHub Copilot

- **Autofix:** with GitHub Code Security and a Copilot licence, open an alert in the Security tab and click **Assign to Copilot**. Copilot's agentic autofix works on third-party SARIF alerts like these. It opens a draft PR and re-runs the analysis to check the fix. Every rule ships detailed help (why, how to fix, and an example), which gives Copilot the context it needs.
- **Copilot in your editor, or the coding agent:** add this to your game repo's `.github/copilot-instructions.md` so Copilot checks its own GML changes:

  ```markdown
  After changing GML code, run `npx github:Mackery6969/GML-Code-Scanner#v1 . --format json`
  and fix any findings. Rule documentation:
  https://github.com/Mackery6969/GML-Code-Scanner/blob/main/docs/rules.md
  ```

## How it compares

| | Feather (GameMaker IDE) | Stitch / VS Code extensions | GML Code Scanner |
| --- | --- | --- | --- |
| Runs in CI / on pull requests | ✗ | ✗ | ✓ |
| GitHub code scanning (SARIF) | ✗ | ✗ | ✓ |
| Security taint tracking across functions | ✗ | ✗ | ✓ |
| `.yyp` / `.yy` integrity checks | ✗ | partial | ✓ |
| Type inference while you type | ✓ | ✓ | ✗ (it is a batch analyser) |

They complement each other: keep Feather or Stitch in your editor, and let this catch what slips through in review.

## GameMaker runtime data

Built-in function signatures, deprecation flags and runtime availability come from GameMaker's own `GmlSpec.xml` and `fnames`. The bundled data covers the LTS 2022 and LTS 2026 runtimes. Availability checks (`gml/runtime-unavailable`) switch on when your project's runtime release line is in the data.

### Checking against your exact runtime

For any other runtime, such as 2023.1, point the scanner at an installed copy. Projects on that release line are then checked against its exact function list. On your own machine:

```sh
npx github:Mackery6969/GML-Code-Scanner#v2 . --runtime-dir "C:/ProgramData/GameMakerStudio2/Cache/runtimes/runtime-2023.1.1.81"
```

Downloading a runtime in GitHub Actions needs a GameMaker account, so let [bscotch/igor-setup](https://github.com/bscotch/igor-setup) do it with your account's access key (see *Building via Command Line* in the GameMaker manual). Save the key as a repository secret named `GAMEMAKER_ACCESS_KEY`, then:

```yaml
jobs:
  scan:
    runs-on: ubuntu-latest
    env:
      # Pull requests from forks don't get secrets; they fall back to the bundled data.
      HAS_GAMEMAKER_KEY: ${{ secrets.GAMEMAKER_ACCESS_KEY != '' }}
    steps:
      - uses: actions/checkout@v7
      - uses: bscotch/igor-setup@v3
        id: igor
        if: env.HAS_GAMEMAKER_KEY == 'true'
        with:
          target-yyp: MyGame/MyGame.yyp   # picks the runtime that matches the project's IDE version
          access-key: ${{ secrets.GAMEMAKER_ACCESS_KEY }}
          cache: true                     # older runtimes are several hundred MB
      - uses: Mackery6969/GML-Code-Scanner@v2
        with:
          runtime-dir: ${{ steps.igor.outputs.runtime-dir }}
```

- The scanner never sees the access key: igor-setup uses it, and the scanner only reads `GmlSpec.xml` and `fnames` from the installed runtime.
- If you already build with igor-setup and igor-build, pass that step's `runtime-dir` instead of setting up a second copy.
- When the step is skipped, `runtime-dir` is empty and the bundled data is used.
- A runtime on a different release line from the project (for example, building a 2023.1 project with 2024.2) isn't used unless you also set `runtime` to its version.

### Updating the bundled data

To add a runtime to the bundled data, install it with the GameMaker IDE and regenerate:

```sh
npm run gen:builtins -- "C:/ProgramData/GameMakerStudio2/Cache/runtimes/runtime-2023.1.1.81" "C:/ProgramData/GameMakerStudio2-LTS2026/Cache/runtimes/runtime-2026.0.0.23" "C:/ProgramData/GameMakerStudio2-LTS/Cache/runtimes/runtime-2022.0.1.30"
```

## Development

```sh
npm ci
npm run typecheck   # tsc (type-check only)
npm test            # node --test
npm run build       # bundles dist/index.js (action) and dist/cli.js (CLI)
npm run scan -- path/to/project
```

`dist/` isn't committed on branches. The release workflow builds it and commits it into each release tag, so pull requests (including Copilot autofix and Dependabot ones) only ever touch the source. Run `npm run docs` when you change a rule's help text; CI checks that `docs/rules.md` is current.

Dependabot keeps the dev tooling and workflow actions up to date.

## Security

Found a vulnerability in the scanner itself (not in a game it scanned)? Please report it privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
