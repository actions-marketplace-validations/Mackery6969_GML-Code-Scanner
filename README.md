# GML Code Scanner

Static analysis and security scanning for **GameMaker** (GML) projects, in the spirit of CodeQL.

It reads your whole project (the `.yyp`, objects, events, scripts, rooms and extensions), not just single files, so it can find problems that only show up across files. Results appear in GitHub's **Security → Code scanning** tab, as annotations on pull requests, and in the job summary.

- **Bugs that crash your game:** undefined functions and variables, missing assets, `"Score: " + 10`, locals used inside callbacks (GML has no closures), wrong argument counts, infinite loops.
- **Security:** taint tracking follows network, HTTP and Steam data (and optionally file and user input) through variables, structs and function calls into `script_execute`, file paths, `variable_instance_set`, shell extensions and more. Each finding shows the full source-to-sink path. It also finds hard-coded API keys, tokens and webhooks in code, `options/` and `datafiles/`.
- **GameMaker-specific mistakes:** alarms reset every step, drawing outside Draw events, surfaces used without `surface_exists`, leaked `ds_*`, surfaces and buffers, unbalanced `surface_set_target`/`shader_set`/`ini_open`.
- **Performance:** per-frame disk I/O, GPU readbacks, uncached `shader_get_uniform`/`layer_get_id`, O(n²) string loops, `instance_number(obj) > 0`.
- **Project integrity:** resources registered twice in the `.yyp` (which crashes the IDE), resources missing from disk or from the `.yyp`, event files the object doesn't list (never run), unused objects and functions, duplicate functions, macros and enums.

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
    - cron: "30 4 * * 1"   # weekly, to pick up new rules

permissions:
  contents: read
  security-events: write   # lets the scanner publish results to the Security tab

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Mackery6969/GML-Code-Scanner@v1
```

That's all. Like CodeQL's analysis step, the action uploads its results to **Security → Code scanning** itself, adds annotations to pull requests, and writes a summary to the job page. If your GameMaker project isn't at the repository root, add `with: path: MyGame`.

- **Public repositories:** code scanning is free, and results show up in the Security tab after the first run.
- **Private repositories without GitHub Code Security:** the upload is skipped with a notice, and you still get pull request annotations and the job summary. Add `with: upload: false` to silence the notice. On pull requests, only findings on the lines the pull request changes are annotated and can fail the job (see `pr-scope`), so existing issues don't bury new ones.
- **Pull requests from forks** can't upload (GitHub gives them a read-only token). They still get annotations.

Want the job to fail on findings? It already does for `error`-level findings. Set `fail-on: warning` to be stricter, or `fail-on: none` to only report.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Folder to scan: a project folder (with a `.yyp`) or a repository containing one or more projects. |
| `config` | | Config file. Defaults to `.gmlscan.json` in the scanned folder. |
| `suite` | `default` | `default`, `security-extended`, `security-and-quality` or `all`. |
| `threat-models` | `remote` | Untrusted data to track: `remote` (network/HTTP/Steam) and/or `local` (files, INI, clipboard, command line, `keyboard_string`). |
| `runtime` | from `.yyp` | Target GameMaker runtime, e.g. `2023.1.1.81`. |
| `upload` | `auto` | Upload to code scanning: `auto` (warn if unavailable), `true` (fail if the upload fails), `false`. |
| `token` | `github.token` | Token for the upload (needs `security-events: write`). |
| `wait-for-processing` | `true` | Wait for GitHub to process the upload and report processing errors. |
| `sarif-file` | `gml-code-scanner.sarif` | Where to write the SARIF report (also usable as an artifact). |
| `category` | `gml-code-scanner` | SARIF category, used to tell several analyses of the same commit apart (for example, several games in one repo). |
| `fail-on` | `error` | Fail the step on findings at this level or above: `error`, `warning`, `note`, `none`. |
| `pr-scope` | `changed-lines` | On pull requests, which findings to annotate and fail on: `changed-lines`, `changed-files` or `all`. The SARIF always has every finding. Needs `pull-requests: read`. |
| `annotations` | `true` | Add inline annotations to the pull request. |
| `max-annotations` | `50` | Maximum annotations per run. |
| `step-summary` | `true` | Write a findings table to the job summary. |

**Outputs:** `sarif-file`, `sarif-id`, `findings`, `errors`, `warnings`, `notes` (on pull requests these count only findings within `pr-scope`), and `total-findings`.

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
  "runtime": "2023.1.1.81"
}
```

### Suppressing findings

```gml
// gmlscan-ignore-next-line gml/resource-leak -- freed by obj_controller
list = ds_list_create();

draw_text(x, y, text); // gmlscan-ignore-line

// gmlscan-ignore-file gml/unused-object
```

Leave out the rule ID to suppress every rule. On GitHub you can also dismiss an alert as "won't fix" or "false positive".

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

Built-in function signatures, deprecation flags and runtime availability are generated from GameMaker's own `GmlSpec.xml` and `fnames`. The bundled data covers the LTS 2022 and LTS 2026 runtimes. Availability checks (`gml/runtime-unavailable`) switch on when your project's runtime release line is in the data. To add another runtime (for example 2023.1), install it with the GameMaker IDE and regenerate:

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
