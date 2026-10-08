import type * as A from "../parser/ast.ts";
import type { ProjectContext, Rule, SourceLocation } from "../engine/types.ts";
import type { YypResourceEntry } from "../project/yy.ts";
import { code } from "./util.ts";

function yypLocation(ctx: ProjectContext, entry: YypResourceEntry): SourceLocation {
  const yyp = ctx.project.yyp!;
  return ctx.locateText(yyp.relPath, yyp.source, entry);
}

function fileLocation(relPath: string): SourceLocation {
  return { file: relPath, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
}

export const duplicateResource: Rule = {
  meta: {
    id: "gml/duplicate-resource",
    name: "DuplicateResource",
    category: "project",
    severity: "error",
    precision: "very-high",
    tier: "default",
    short: "Resource is registered twice in the .yyp, or two resources share a name.",
    full: "A resource listed more than once in the project file, or two resources with the same name, make GameMaker crash or fail to load the project. This usually comes from a bad merge.",
    help: `The \`.yyp\` project file lists the same resource more than once, or two different resources have the same name. GameMaker crashes or refuses to load the project, and asset references become ambiguous. This almost always comes from a merge conflict resolved by keeping both sides.

**How to fix:** open the \`.yyp\` in a text editor and delete the duplicate entry in \`"resources"\`, or rename one of the clashing resources in the IDE.`,
  },
  project(ctx) {
    const yyp = ctx.project.yyp;
    if (!yyp) return;
    const byPath = new Map<string, YypResourceEntry[]>();
    for (const e of yyp.entries) {
      const key = e.path.toLowerCase();
      byPath.set(key, [...(byPath.get(key) ?? []), e]);
    }
    for (const entries of byPath.values()) {
      for (const dup of entries.slice(1)) {
        ctx.report(yypLocation(ctx, dup), `${code(dup.name)} (${dup.path}) is registered ${entries.length} times in ${yyp.relPath.split("/").pop()}; GameMaker crashes when a resource is listed twice.`, {
          related: [{ location: yypLocation(ctx, entries[0]), message: "First entry" }],
        });
      }
    }
    const byName = new Map<string, YypResourceEntry[]>();
    for (const e of yyp.entries) {
      const list = byName.get(e.name) ?? [];
      if (!list.some((x) => x.path.toLowerCase() === e.path.toLowerCase())) list.push(e);
      byName.set(e.name, list);
    }
    for (const [name, entries] of byName) {
      if (entries.length < 2) continue;
      for (const dup of entries.slice(1)) {
        ctx.report(yypLocation(ctx, dup), `Two resources are named ${code(name)} (${entries[0].path} and ${dup.path}); asset names must be unique.`, {
          related: [{ location: yypLocation(ctx, entries[0]), message: "Other resource with this name" }],
        });
      }
    }
  },
};

export const missingResourceFile: Rule = {
  meta: {
    id: "gml/missing-resource-file",
    name: "MissingResourceFile",
    category: "project",
    severity: "error",
    precision: "very-high",
    tier: "default",
    short: "Resource registered in the .yyp has no .yy file on disk.",
    full: "The project file references a resource whose .yy file does not exist, so GameMaker cannot load the project.",
    help: `The \`.yyp\` lists a resource whose \`.yy\` file is missing. GameMaker fails to load the project. This happens when a resource folder was deleted or renamed outside the IDE, or not committed.

**How to fix:** restore (or commit) the resource folder, or remove the entry from \`"resources"\` in the \`.yyp\`.`,
  },
  project(ctx) {
    const yyp = ctx.project.yyp;
    if (!yyp) return;
    for (const list of ctx.project.resources.values()) {
      for (const r of list) {
        if (!r.inYyp || r.onDisk) continue;
        for (const e of r.yypEntries) ctx.report(yypLocation(ctx, e), `${code(r.name)} is registered in the project, but ${r.yyRelPath} does not exist; GameMaker cannot load the project.`);
      }
    }
  },
};

/** Workspace-relative location of the first reference to any of `names` outside `exclude`'s own files. */
function firstReference(ctx: ProjectContext, names: Set<string>, exclude: string): SourceLocation | undefined {
  for (const [file, scopes] of ctx.index.scopes) {
    if (file.resource === exclude) continue;
    for (const ref of scopes.refs) {
      if (ref.binding.kind === "free" && names.has(ref.id.name)) return ctx.locate(file, ref.id);
    }
  }
  return undefined;
}

export const unregisteredResource: Rule = {
  meta: {
    id: "gml/unregistered-resource",
    name: "UnregisteredResource",
    category: "project",
    severity: "error",
    precision: "high",
    tier: "default",
    short: "Resource folder exists on disk but is not registered in the .yyp.",
    full: "GameMaker only loads resources listed in the project file. A resource folder that is not registered is ignored, and code that uses it fails to compile.",
    help: `GameMaker only loads resources that are listed in the \`.yyp\` project file. This resource's folder and \`.yy\` exist on disk, but it isn't registered, so GameMaker ignores it. Any code that uses it (the object, or the functions in the script) fails to compile.

This usually happens when a resource folder was copied in from another project, or after a merge that lost the \`.yyp\` change.

**How to fix:** re-add the resource through the IDE (*Add Existing* / drag it into the Asset Browser), or add a \`{"id":{"name":"...","path":"..."}}\` entry to \`"resources"\` in the \`.yyp\`. If the folder is left over, delete it.`,
  },
  project(ctx) {
    const { project, index } = ctx;
    if (!project.yyp) return;
    for (const list of project.resources.values()) {
      for (const r of list) {
        if (r.inYyp || !r.onDisk) continue;
        const names = new Set([r.name]);
        if (r.type === "scripts") {
          for (const [fname, infos] of index.globalFunctions) if (infos.some((i) => i.file.resource === r.name && i.file.kind === "script")) names.add(fname);
        }
        const used = firstReference(ctx, names, r.name);
        const yypName = project.yyp.relPath.split("/").pop();
        if (used) {
          ctx.report(used, `This uses ${r.type === "scripts" && !names.has(r.name) ? "a function from " : ""}${code(r.name)}, but ${r.yyRelPath} is not registered in ${yypName}; GameMaker ignores unregistered resources, so this fails to compile.`, {
            related: [{ location: fileLocation(r.yyRelPath), message: "Unregistered resource" }],
          });
        } else {
          ctx.report(fileLocation(r.yyRelPath), `${r.type.replace(/s$/, "")} ${code(r.name)} exists on disk but is not registered in ${yypName}; GameMaker ignores it.`, { severity: "warning" });
        }
      }
    }
  },
};

export const orphanedEventFile: Rule = {
  meta: {
    id: "gml/orphaned-event-file",
    name: "OrphanedEventFile",
    category: "project",
    severity: "warning",
    precision: "high",
    tier: "default",
    short: "Object event file is not listed in the object's .yy (it never runs), or a listed event has no file.",
    full: "An object's events are defined by the `eventList` in its .yy file. An event .gml file that is not listed there is never compiled or run.",
    help: `An object's events are defined by the \`eventList\` in its \`.yy\` file. A \`Step_0.gml\` (or similar) file that isn't listed there **is never compiled or run**, even though it sits in the object's folder. The reverse, an event listed without its \`.gml\` file, makes GameMaker complain when loading the project.

This usually comes from merges where the \`.yy\` change and the \`.gml\` file ended up out of sync.

**How to fix:** re-create the event in the IDE (paste the code back in), or add or remove the matching entry in the object's \`.yy\` \`eventList\`.`,
  },
  project(ctx) {
    const { project } = ctx;
    if (!project.yyp) return;
    const guid = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
    for (const obj of project.objects.values()) {
      if (!obj.eventList) continue;
      const matched = new Set<number>();
      for (const file of obj.events) {
        const ev = file.event;
        if (!ev) continue;
        if (ev.collisionObject && guid.test(ev.collisionObject)) continue;
        const idx = obj.eventList.findIndex((e, i) => !matched.has(i) && e.eventType === ev.eventType && (ev.kind === "Collision" ? e.collisionObject === ev.collisionObject : e.eventNum === ev.num));
        if (idx >= 0) matched.add(idx);
        else ctx.report(ctx.locate(file, { start: 0, end: 0 }), `${ev.displayName} event file of ${code(obj.name)} is not listed in ${obj.yyRelPath}, so this code never runs.`);
      }
      obj.eventList.forEach((e, i) => {
        if (matched.has(i)) return;
        if (e.eventType === 4 && e.collisionObject === undefined) return;
        const hasFile = obj.events.some((f) => f.event?.eventType === e.eventType && (e.eventType === 4 ? f.event.collisionObject === e.collisionObject || guid.test(f.event.collisionObject ?? "") : f.event.num === e.eventNum));
        if (!hasFile) ctx.report(fileLocation(obj.yyRelPath), `${code(obj.name)} lists an event (type ${e.eventType}, number ${e.collisionObject ?? e.eventNum}) whose .gml file is missing.`);
      });
    }
  },
};

export const unusedObject: Rule = {
  meta: {
    id: "gml/unused-object",
    name: "UnusedObject",
    category: "project",
    severity: "note",
    precision: "medium",
    tier: "default",
    short: "Object is never placed, created, inherited from or referenced.",
    full: "No room, sequence, other object, code or string literal refers to this object, so it can never exist in the game.",
    help: `Nothing refers to this object: it isn't placed in any room or sequence, no other object inherits from it or collides with it, no code outside its own events mentions it, and no string literal names it (for \`asset_get_index\`). It can never exist at runtime.

**How to fix:** delete it if it's dead, or suppress this note (\`// gmlscan-ignore-file gml/unused-object\` in one of its events, or list it in \`ignore\`) if it's created in a way the scanner can't see.`,
  },
  project(ctx) {
    const { project, index } = ctx;
    if (!project.yyp) return;
    for (const obj of project.objects.values()) {
      const registered = project.resources.get(obj.name)?.some((r) => r.inYyp && r.type === "objects");
      if (!registered) continue;
      if (project.yyReferences.get(obj.name)?.size) continue;
      if (index.stringLiterals.has(obj.name)) continue;
      let used = false;
      for (const [resource, names] of index.refsByResource) {
        if (resource !== obj.name && names.has(obj.name)) {
          used = true;
          break;
        }
      }
      if (used) continue;
      const loc = obj.events[0] ? ctx.locate(obj.events[0], { start: 0, end: 0 }) : fileLocation(obj.yyRelPath);
      ctx.report(loc, `Unused object ${code(obj.name)}: it is not placed in any room or sequence, not inherited from, and not referenced by other code.${index.usesDynamicAssetNames ? " (The project looks up some assets by computed names, which the scanner cannot follow.)" : ""}`);
    }
  },
};

export const unusedFunction: Rule = {
  meta: {
    id: "gml/unused-function",
    name: "UnusedFunction",
    category: "project",
    severity: "note",
    precision: "medium",
    tier: "default",
    short: "Script function is never called or referenced.",
    full: "The global function is never called, passed as a value, or named in a string anywhere in the project.",
    help: `This script function is never called, passed as a callback, or named in a string anywhere in the project. It's dead code (or only used by code the scanner doesn't see, such as extensions or dynamic \`asset_get_index\` lookups with computed names).

Two kinds of functions are never reported, because they are used without a direct call:

- functions called from \`gml_pragma("global", "...")\` code, which GameMaker runs before the first room;
- functions that declare an enum used elsewhere. Enums are global at compile time, so deleting the function would delete the enum.

**How to fix:** delete it, or suppress the note if it's part of a library API.`,
  },
  project(ctx) {
    const { index } = ctx;
    if (!ctx.project.yyp) return; // a partial folder may be used by code the scanner cannot see
    const enumHolders = new Set<A.FunctionNode>();
    for (const [enumName, decls] of index.enums) {
      if (!index.identifierRefs.get(enumName)) continue;
      for (const d of decls) {
        for (const fn of index.functionsByNode.values()) {
          if (fn.file === d.file && fn.isGlobal && d.node.start >= fn.node.start && d.node.end <= fn.node.end) enumHolders.add(fn.node);
        }
      }
    }
    for (const [name, infos] of index.globalFunctions) {
      if (infos.length !== 1) continue;
      const fn = infos[0];
      if (index.pragmaGlobalCalls.has(name) || enumHolders.has(fn.node)) continue;
      const total = index.identifierRefs.get(name) ?? 0;
      let self = 0;
      for (const ref of index.scopes.get(fn.file)?.refs ?? []) {
        if (ref.id.name === name && ref.id.start >= fn.node.start && ref.id.end <= fn.node.end) self++;
      }
      if (total - self > 0 || index.stringLiterals.has(name)) continue;
      const decl = fn.node.type === "FunctionDeclaration" ? fn.node.id : fn.node;
      ctx.report(ctx.locate(fn.file, decl), `Unused function ${code(name)}.`);
    }
  },
};

export const duplicateFunction: Rule = {
  meta: {
    id: "gml/duplicate-function",
    name: "DuplicateFunction",
    category: "project",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Global function defined more than once, or clashing with an asset name.",
    full: "Two scripts declare a function with the same name (only one wins at runtime), or a function has the same name as an asset.",
    help: `Script functions are global, so two with the same name clash: only one of them is used at runtime, and which one depends on compile order. A function that shares its name with an asset (sprite, object, sound ...) shadows or is shadowed by that asset.

**How to fix:** rename one of them. A common convention is a prefix per system, for example \`player_move\` and \`enemy_move\`.`,
  },
  project(ctx) {
    const { index } = ctx;
    for (const [name, infos] of index.globalFunctions) {
      for (const dup of infos.slice(1)) {
        const first = infos[0];
        ctx.report(ctx.locate(dup.file, dup.node.type === "FunctionDeclaration" ? dup.node.id : dup.node), `Function ${code(name)} is also defined in ${first.file.relPath}; only one definition is used at runtime.`, {
          related: [{ location: ctx.locate(first.file, first.node.type === "FunctionDeclaration" ? first.node.id : first.node), message: "Other definition" }],
        });
      }
      const assetType = index.assets.get(name);
      const fn = infos[0];
      if (assetType && !(assetType === "scripts" && fn.file.resource === name)) {
        ctx.report(ctx.locate(fn.file, fn.node.type === "FunctionDeclaration" ? fn.node.id : fn.node), `Function ${code(name)} has the same name as ${assetType.replace(/s$/, "")} asset ${code(name)}.`);
      }
    }
  },
};

export const duplicateMacro: Rule = {
  meta: {
    id: "gml/duplicate-macro",
    name: "DuplicateMacro",
    category: "project",
    severity: "error",
    precision: "very-high",
    tier: "default",
    short: "Macro defined more than once for the same configuration.",
    full: "GameMaker macros are global; defining the same macro twice (for the same configuration) is an error.",
    help: `Macros are global. Defining the same macro twice for the same configuration is a compile error, or one silently wins.

Configuration-specific macros are fine:

\`\`\`gml
#macro API_URL "https://api.example.com"
#macro Debug:API_URL "http://localhost:8080"   // OK: different configuration
\`\`\``,
  },
  project(ctx) {
    for (const [name, decls] of ctx.index.macros) {
      const byConfig = new Map<string, typeof decls>();
      for (const d of decls) {
        const key = d.node.config ?? "";
        byConfig.set(key, [...(byConfig.get(key) ?? []), d]);
      }
      for (const [config, list] of byConfig) {
        for (const dup of list.slice(1)) {
          ctx.report(ctx.locate(dup.file, dup.node.id), `Macro ${code(config ? `${config}:${name}` : name)} is already defined in ${list[0].file.relPath}.`, {
            related: [{ location: ctx.locate(list[0].file, list[0].node.id), message: "First definition" }],
          });
        }
      }
    }
  },
};

export const duplicateEnum: Rule = {
  meta: {
    id: "gml/duplicate-enum",
    name: "DuplicateEnum",
    category: "project",
    severity: "error",
    precision: "very-high",
    tier: "default",
    short: "Enum or enum member defined more than once.",
    full: "Enums are global; two enums with the same name, or two members with the same name in one enum, are compile errors.",
    help: `Enums are global. Two enums with the same name, or a repeated member inside one enum, won't compile (or silently conflict).`,
  },
  project(ctx) {
    for (const [name, decls] of ctx.index.enums) {
      for (const dup of decls.slice(1)) {
        ctx.report(ctx.locate(dup.file, dup.node.id), `Enum ${code(name)} is already defined in ${decls[0].file.relPath}.`, {
          related: [{ location: ctx.locate(decls[0].file, decls[0].node.id), message: "First definition" }],
        });
      }
      for (const d of decls) {
        const seen = new Set<string>();
        for (const m of d.node.members) {
          if (seen.has(m.id.name)) ctx.report(ctx.locate(d.file, m.id), `Enum member ${code(`${name}.${m.id.name}`)} is defined twice.`);
          seen.add(m.id.name);
        }
      }
    }
  },
};

export const PROJECT_RULES: Rule[] = [
  duplicateResource,
  missingResourceFile,
  unregisteredResource,
  orphanedEventFile,
  unusedObject,
  unusedFunction,
  duplicateFunction,
  duplicateMacro,
  duplicateEnum,
];
