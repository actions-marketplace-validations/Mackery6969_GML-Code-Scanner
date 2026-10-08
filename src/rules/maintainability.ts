import type * as A from "../parser/ast.ts";
import { isTerminator, walk } from "../parser/walk.ts";
import type { Rule } from "../engine/types.ts";
import type { GmlFile } from "../project/loader.ts";
import type { Scope } from "../semantic/scope.ts";
import { code, describeEvent } from "./util.ts";

export const legacyEquality: Rule = {
  meta: {
    id: "gml/legacy-equality",
    name: "LegacyEquality",
    category: "maintainability",
    severity: "note",
    precision: "very-high",
    tier: "quality",
    short: "`=` used as a comparison.",
    full: "GML accepts `=` as a comparison inside expressions for backwards compatibility, but it reads like an assignment. Use `==`.",
    help: `GML still accepts a single \`=\` as a comparison inside expressions (for GameMaker 8 compatibility), but it reads like an assignment and hides real mistakes.

\`\`\`gml
if (state = "idle") { ... }    // before
if (state == "idle") { ... }   // after
\`\`\``,
  },
  file(ctx) {
    return {
      BinaryExpression(n) {
        if (n.rawOperator === "=") ctx.report(n, "Use `==` for comparisons; `=` here is legacy comparison syntax.");
      },
    };
  },
};

export const globalvarDeclaration: Rule = {
  meta: {
    id: "gml/globalvar",
    name: "GlobalvarDeclaration",
    category: "maintainability",
    severity: "note",
    precision: "very-high",
    tier: "quality",
    short: "`globalvar` is deprecated.",
    full: "`globalvar` declarations are deprecated. Use the `global.` prefix instead.",
    help: `\`globalvar\` is deprecated. It makes globals indistinguishable from instance variables and may be removed in future versions.

\`\`\`gml
globalvar coins; coins = 0;   // before
global.coins = 0;             // after
\`\`\``,
  },
  file(ctx) {
    return {
      VarDeclaration(n) {
        if (n.kind === "globalvar") ctx.report(n, `${code("globalvar")} is deprecated; use ${code(`global.${n.declarations[0]?.id.name ?? "name"}`)} instead.`);
      },
    };
  },
};

export const legacyArray2d: Rule = {
  meta: {
    id: "gml/legacy-array-2d",
    name: "LegacyArray2D",
    category: "maintainability",
    severity: "note",
    precision: "very-high",
    tier: "quality",
    short: "Legacy `a[i, j]` 2D array syntax.",
    full: "Since GameMaker 2.3 arrays are one-dimensional and nested; `a[i, j]` is legacy syntax for `a[i][j]`.",
    help: `GameMaker 2.3 replaced 2D arrays with arrays of arrays. \`a[i, j]\` still compiles as \`a[i][j]\`, but it is legacy syntax and doesn't work with array functions the way you might expect.

\`\`\`gml
grid[i, j] = 0;    // before
grid[i][j] = 0;    // after
\`\`\``,
  },
  file(ctx) {
    return {
      IndexExpression(n) {
        if ((n.accessor === "" || n.accessor === "@") && n.indices.length === 2) ctx.report(n, "Legacy 2D array syntax; write `a[i][j]` instead of `a[i, j]`.");
      },
    };
  },
};

export const legacyArguments: Rule = {
  meta: {
    id: "gml/legacy-arguments",
    name: "LegacyArgumentVariables",
    category: "maintainability",
    severity: "note",
    precision: "high",
    tier: "quality",
    short: "`argument0`/`argument[n]` used instead of named parameters.",
    full: "Functions declared with `function` can use named parameters, which are clearer and checked by tooling.",
    help: `Named parameters are clearer than \`argument0\`/\`argument[n]\`, can have default values, and let tools check calls.

\`\`\`gml
function scr_damage() { hp -= argument0; }          // before
function scr_damage(amount) { hp -= amount; }       // after
\`\`\`

\`argument_count\` and \`argument[i]\` remain the right tool for genuinely variadic functions.`,
  },
  file(ctx) {
    const reported = new Set<A.Node>();
    return {
      Identifier(n) {
        if (!/^argument\d+$/.test(n.name)) return;
        const ref = ctx.scopes.refOf.get(n);
        const fn = ctx.enclosingFunction();
        if (!ref || ref.binding.kind !== "free" || !fn || reported.has(fn)) return;
        reported.add(fn);
        ctx.report(n, `${code(n.name)} is legacy; declare named parameters on the function instead.`);
      },
    };
  },
};

export const implicitGlobal: Rule = {
  meta: {
    id: "gml/implicit-global",
    name: "ImplicitGlobal",
    category: "maintainability",
    severity: "note",
    precision: "high",
    tier: "quality",
    short: "Assignment in script global scope creates a hidden global.",
    full: "Top-level script code runs in global scope, so `name = value` there creates `global.name`, which instances cannot read as `name`.",
    help: `Script code outside any function runs once at game start in **global scope**. A plain assignment there (\`speed_max = 4;\`) creates \`global.speed_max\`. Instances then read \`speed_max\` as their *own* (undefined) instance variable, not the global.

**How to fix:** write \`global.speed_max = 4;\` explicitly (and read it as \`global.speed_max\`), or use a \`#macro\` for constants.`,
  },
  file(ctx) {
    if (ctx.file.kind !== "script") return;
    const reported = new Set<string>();
    return {
      Identifier(n) {
        const ref = ctx.scopes.refOf.get(n);
        if (!ref || ref.binding.kind !== "free" || ref.access === "read" || ref.scope !== ctx.scopes.root || ref.withDepth > 0 || ref.inMacro) return;
        if (reported.has(n.name) || ctx.index.globalvarNames.has(n.name)) return;
        reported.add(n.name);
        ctx.report(n, `${code(n.name)} is assigned in global scope, which creates ${code(`global.${n.name}`)}; write it as ${code(`global.${n.name}`)} to make that explicit.`);
      },
    };
  },
};

interface JsdocParam {
  name: string;
  start: number;
  end: number;
}

function jsdocParams(text: string, fnStart: number): JsdocParam[] {
  const params: JsdocParam[] = [];
  let i = fnStart;
  while (i > 0) {
    const lineStart = text.lastIndexOf("\n", i - 2) + 1;
    const raw = text.slice(lineStart, i);
    const line = raw.trim();
    if (!line.startsWith("//")) break;
    const m = /@(?:param|arg|argument)\s+(?:\{[^}]*\}\s*)?\[?([A-Za-z_]\w*)/.exec(line);
    if (m) {
      const offset = lineStart + raw.indexOf(m[1], raw.indexOf("@"));
      params.unshift({ name: m[1], start: offset, end: offset + m[1].length });
    }
    i = lineStart;
  }
  return params;
}

export const jsdocParamMismatch: Rule = {
  meta: {
    id: "gml/jsdoc-param-mismatch",
    name: "JsdocParamMismatch",
    category: "maintainability",
    severity: "note",
    precision: "high",
    tier: "quality",
    short: "JSDoc `@param` does not match the function's parameters.",
    full: "The `/// @param` comments above a function name parameters that differ from the declared ones, which misleads Feather, Stitch and readers.",
    help: `The \`/// @param\` documentation above this function doesn't match its declared parameters. GameMaker's Feather and editor extensions such as Stitch use these comments for autocomplete and type hints, so a stale comment gives wrong hints.

\`\`\`gml
/// @param {Id.Instance} target
/// @param {Real} amount
function scr_damage(target, dmg) { ... }   // "amount" vs "dmg"
\`\`\``,
  },
  file(ctx) {
    return {
      FunctionDeclaration(n) {
        const docs = jsdocParams(ctx.file.source.text, n.start);
        if (docs.length === 0 || n.params.length === 0) return;
        for (let i = 0; i < docs.length; i++) {
          const p = n.params[i];
          if (!p) {
            ctx.report(docs[i], `JSDoc documents parameter ${code(docs[i].name)}, but function ${code(n.id.name)} has only ${n.params.length}.`);
            return;
          }
          if (p.id.name !== docs[i].name) {
            ctx.report(docs[i], `Parameter name mismatch: JSDoc says ${code(docs[i].name)} but parameter ${i + 1} of ${code(n.id.name)} is ${code(p.id.name)}.`);
            return;
          }
        }
      },
    };
  },
};

export const missingEventInherited: Rule = {
  meta: {
    id: "gml/missing-event-inherited",
    name: "MissingEventInherited",
    category: "maintainability",
    severity: "note",
    precision: "medium",
    tier: "quality",
    short: "Child object overrides a parent event without calling event_inherited().",
    full: "When a child object defines an event its parent also defines, the parent's code does not run unless the child calls `event_inherited()`.",
    help: `When a child object defines an event that its parent also defines, the child's version **replaces** the parent's. The parent's code (often initialisation in Create) only runs if the child calls \`event_inherited()\`.

This is sometimes intentional (a full override). If it isn't, add the call:

\`\`\`gml
// obj_enemy_bat, Create event
event_inherited();   // runs obj_enemy's Create first
flying = true;
\`\`\``,
  },
  project(ctx) {
    const { project } = ctx;
    const eventKey = (f: { event?: { kind: string; num: number; collisionObject?: string } }) => (f.event ? `${f.event.kind}_${f.event.collisionObject ?? f.event.num}` : "");
    for (const obj of project.objects.values()) {
      if (!obj.parent) continue;
      for (const ev of obj.events) {
        if (!ev.event || ev.event.kind !== "Create") continue;
        const key = eventKey(ev);
        let ancestor = project.objects.get(obj.parent);
        const seen = new Set<string>();
        let parentHas: string | undefined;
        while (ancestor && !seen.has(ancestor.name)) {
          seen.add(ancestor.name);
          if (ancestor.events.some((e) => eventKey(e) === key)) {
            parentHas = ancestor.name;
            break;
          }
          ancestor = ancestor.parent ? project.objects.get(ancestor.parent) : undefined;
        }
        if (!parentHas) continue;
        let calls = false;
        walk(ev.ast, (n) => {
          if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "event_inherited") calls = true;
        });
        if (calls) continue;
        ctx.report(ctx.locate(ev, { start: 0, end: 0 }), `${code(obj.name)} overrides the ${ev.event.displayName} event of ${code(parentHas)} without calling event_inherited(), so the parent's ${ev.event.displayName} code does not run.`);
      }
    }
  },
};

export const unusedLocal: Rule = {
  meta: {
    id: "gml/unused-local",
    name: "UnusedLocal",
    category: "maintainability",
    severity: "note",
    precision: "high",
    tier: "quality",
    short: "Local variable is never read.",
    full: "A `var` local is declared (and maybe assigned) but its value is never used.",
    help: `This local variable is never read. Remove it, or use it. An unused local often points to a typo elsewhere, where a similar name is used instead.`,
  },
  file(ctx) {
    const visitScope = (scope: Scope) => {
      for (const decls of scope.locals.values()) {
        for (const d of decls) {
          if (d.kind !== "var" || d.reads.length > 0 || d.name === "_") continue;
          // Another declaration of the same name may be the one that is read.
          if (decls.some((o) => o !== d && o.reads.length > 0)) continue;
          ctx.report(d.id, `Unused local variable ${code(d.name)}.`);
        }
      }
      scope.children.forEach(visitScope);
    };
    return { "file:exit": () => visitScope(ctx.scopes.root) };
  },
};

export const constantCondition: Rule = {
  meta: {
    id: "gml/constant-condition",
    name: "ConstantCondition",
    category: "maintainability",
    severity: "note",
    precision: "high",
    tier: "quality",
    short: "`if` condition is a constant.",
    full: "An `if` whose condition is a literal always takes the same branch; often leftover debug code.",
    help: `An \`if (true)\` / \`if (false)\` / \`if (0)\` always takes the same branch. It is usually leftover debugging code. If you need a debug toggle, use a \`#macro\` so it is clearly intentional:

\`\`\`gml
#macro DEBUG_DRAW false
if (DEBUG_DRAW) { ... }
\`\`\``,
  },
  file(ctx) {
    return {
      IfStatement(n) {
        const t = n.test;
        if (t.type === "BooleanLiteral" || t.type === "NumberLiteral") {
          const truthy = t.type === "BooleanLiteral" ? t.value : t.value >= 0.5;
          ctx.report(t, `This condition is always ${truthy ? "true" : "false"}.`);
        }
      },
    };
  },
};

export const switchFallthrough: Rule = {
  meta: {
    id: "gml/switch-fallthrough",
    name: "SwitchFallthrough",
    category: "correctness",
    severity: "warning",
    precision: "medium",
    tier: "quality",
    short: "Switch case falls through to the next case.",
    full: "A non-empty `case` without `break`, `return`, `exit` or `continue` continues into the next case's code.",
    help: `This \`case\` has code but no \`break\`, so execution continues into the next case. That is a classic source of bugs. If it's intentional, add a \`// fallthrough\` comment to make that clear (this also silences the warning).

\`\`\`gml
switch (dir) {
    case 0: x += 1;          // falls into case 1
    case 1: y += 1; break;
}
\`\`\``,
  },
  file(ctx) {
    const comments = ctx.file.ast.comments;
    return {
      SwitchStatement(n) {
        for (let i = 0; i < n.cases.length - 1; i++) {
          const c = n.cases[i];
          if (c.body.length === 0) continue;
          const last = c.body[c.body.length - 1];
          if (isTerminator(last)) continue;
          const next = n.cases[i + 1];
          const annotated = comments.some((cm) => cm.start >= last.end && cm.end <= next.start + 1 && /fall(s)?[\s-]?through/i.test(cm.value));
          if (annotated) continue;
          ctx.report(c.test ?? c, "This case falls through into the next one; add `break` (or a `// fallthrough` comment if intentional).");
        }
      },
    };
  },
};

export const duplicateStructKey: Rule = {
  meta: {
    id: "gml/duplicate-struct-key",
    name: "DuplicateStructKey",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Struct literal defines the same key twice.",
    full: "The later value silently overwrites the earlier one.",
    help: `The same key appears twice in a struct literal; the second value silently overwrites the first. One of them is probably misspelled.

\`\`\`gml
var stats = { hp: 10, speed: 2, hp: 12 };   // hp is 12
\`\`\``,
  },
  file(ctx) {
    return {
      StructExpression(n) {
        const seen = new Map<string, A.Node>();
        for (const p of n.properties) {
          if (p.type !== "StructProperty") continue;
          const key = p.key.type === "Identifier" ? p.key.name : p.key.value;
          const first = seen.get(key);
          if (first) ctx.report(p.key, `Duplicate struct key ${code(key)}; this value overwrites the earlier one.`, { related: [{ location: ctx.locate(first), message: "First definition" }] });
          else seen.set(key, p.key);
        }
      },
    };
  },
};

function declarationSite(file: GmlFile): string | undefined {
  switch (file.kind) {
    case "object-event":
      return describeEvent(file);
    case "room-creation":
      return `the creation code of room ${code(file.resource)}`;
    case "instance-creation": {
      const instance = file.relPath.split("/").pop()!.replace(/^InstanceCreationCode_/, "").replace(/\.gml$/, "");
      return `the creation code of instance ${code(instance)} in room ${code(file.resource)}`;
    }
    case "timeline-moment":
      return `a moment of timeline ${code(file.resource)}`;
    default:
      return undefined;
  }
}

export const declarationOutsideScript: Rule = {
  meta: {
    id: "gml/declaration-outside-script",
    name: "DeclarationOutsideScript",
    category: "maintainability",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Enum, macro or globalvar declared in an object event or creation code instead of a script.",
    full: "Enums, macros and globalvars are global no matter where they are written. Declared in an object event or a room or instance creation code, they are hard to find, and tools that only index scripts report every use as undeclared.",
    help: `Enums, macros and \`globalvar\` declarations are global: GameMaker compiles them into the whole game no matter which file they're written in. Declaring one in an object event, a room's creation code, an instance's creation code or a timeline hides it:

- readers look for shared declarations in scripts, not in the creation code of one room or the Create event of one object;
- the location suggests it only applies to that room or object, but it doesn't;
- editor tooling and language servers that only index scripts don't see the declaration, so they report every use of the enum or macro as undeclared.

**How to fix:** move the declaration into a script, next to the functions that use it (or into a dedicated script such as \`scr_enums\`). This doesn't change behavior: enums and macros are resolved at compile time.

Plain \`global.name = value\` assignments are **not** reported: creation code is a reasonable place to set up runtime state, and moving such an assignment to a script would change when it runs.

\`\`\`gml
// rooms/rm_title/RoomCreationCode.gml (bad)
enum states { idle, walk, jump }
#macro ANIMATION_END (image_index >= image_number - 1)

// scripts/scr_states/scr_states.gml (good)
enum states { idle, walk, jump }
#macro ANIMATION_END (image_index >= image_number - 1)
\`\`\``,
  },
  file(ctx) {
    const site = declarationSite(ctx.file);
    if (!site) return;
    return {
      EnumDeclaration(n) {
        ctx.report(n.id, `Enum ${code(n.id.name)} is declared in ${site}. Enums are global; declare it in a script so it's easy to find.`);
      },
      MacroDeclaration(n) {
        ctx.report(n.id, `Macro ${code(n.id.name)} is declared in ${site}. Macros are global; declare it in a script so it's easy to find.`);
      },
      VarDeclaration(n) {
        if (n.kind !== "globalvar") return;
        for (const d of n.declarations) ctx.report(d.id, `Global variable ${code(d.id.name)} is declared with \`globalvar\` in ${site}. Declare globals in a script, as \`global.${d.id.name}\`.`);
      },
    };
  },
};

export const MAINTAINABILITY_RULES: Rule[] = [
  legacyEquality,
  globalvarDeclaration,
  legacyArray2d,
  legacyArguments,
  implicitGlobal,
  jsdocParamMismatch,
  missingEventInherited,
  unusedLocal,
  constantCondition,
  switchFallthrough,
  duplicateStructKey,
  declarationOutsideScript,
];
