import type { Rule } from "../engine/types.ts";

/**
 * Dependency rules have no file or project visitors: their findings come from the update
 * check (src/deps/updates.ts), which needs the network and runs after the scan.
 */
export const outdatedDependency: Rule = {
  meta: {
    id: "gml/outdated-dependency",
    name: "OutdatedDependency",
    category: "dependencies",
    severity: "note",
    precision: "high",
    tier: "default",
    short: "A newer version of an extension or library supports this project's GameMaker version.",
    full: "An extension or a library copied into the project has a newer release that works with the GameMaker runtime the project targets. Updates that need a newer runtime are only reported when runtime updates are turned on.",
    help: `A newer version of this extension or library is available, and it supports the GameMaker version your project targets (the \`IDEVersion\` in the \`.yyp\`, or \`runtime\` in \`.gmlscan.json\`).

The scanner recognises:

- **Extensions** by name (and the functions they define), with the version from \`extensionVersion\` in the extension's \`.yy\`. YoYo Games' official extensions (Steamworks, FMOD, AdMob, Firebase and more) are built in.
- **Libraries copied into your scripts** by their version macro, e.g. \`#macro SCRIBBLE_VERSION "9.7.3"\` (Scribble, Input, SNAP, Chatterbox, Vinyl, Bulb, Dynamo, Coroutines, iota, Collage).
- **GMLive**, by the date in its generated script's header, against the GameMaker Marketplace.

A release counts as compatible when GameMaker can import it into your project. The scanner reads the IDE version the release's \`.yymps\` package was exported from, plus any minimum stated in the release notes (such as "GM 2023.1 and future releases"). Releases it can't verify show up in the job summary, but don't raise an alert.

**How to fix:** download the new version from the linked release and import it (**Tools → Import Local Package** in the IDE). When the action runs on your default branch with \`contents: write\` and \`pull-requests: write\` permissions, it opens a pull request that updates extensions for you.

**Not interested in this update?** Add the dependency to \`dependencies.ignore\` in \`.gmlscan.json\`, either entirely or for some versions or update types:

\`\`\`jsonc
"dependencies": {
  "ignore": [
    "GMLive",
    { "name": "Steamworks", "updateTypes": ["major"] },
    { "name": "Scribble", "versions": ["10.x"] }
  ]
}
\`\`\``,
  },
};

export const runtimeUpdate: Rule = {
  meta: {
    id: "gml/runtime-update",
    name: "RuntimeUpdate",
    category: "dependencies",
    severity: "note",
    precision: "very-high",
    tier: "default",
    short: "A newer GameMaker runtime is available.",
    full: "GameMaker has released a newer runtime than the one this project targets. Only reported when runtime updates are turned on.",
    help: `GameMaker has released a newer runtime than the one this project targets (the \`IDEVersion\` in the \`.yyp\`, or \`runtime\` in \`.gmlscan.json\`). The scanner reads YoYo Games' release feeds for the monthly releases and each LTS line.

This is only reported with \`"dependencies": { "runtimeUpdates": true }\` in \`.gmlscan.json\` (or \`runtime-updates: true\` in the workflow). With it on, \`gml/outdated-dependency\` also reports extension and library updates that need a newer runtime, and says which runtime they need.

**How to fix:** update GameMaker and open the project in the new IDE once, so it can upgrade the project format. Read the release notes first: new runtimes can change behaviour, and projects saved by a newer IDE can't be opened by an older one.`,
  },
};

export const DEPENDENCY_RULES: Rule[] = [outdatedDependency, runtimeUpdate];
