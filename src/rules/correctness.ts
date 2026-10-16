import type * as A from "../parser/ast.ts";
import { forEachChild, isTerminator, walk } from "../parser/walk.ts";
import type { Rule } from "../engine/types.ts";
import { KNOWN_RUNTIMES, LEGACY_REPLACEMENTS, availableInRuntime, getBuiltinFunction, getBuiltinVariable, isBuiltinFunction } from "../semantic/builtins.ts";
import type { FunctionInfo } from "../semantic/project-index.ts";
import { code, isSideEffectFree, normalizeSelf, sameExpression, staticType } from "./util.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const undefinedFunction: Rule = {
  meta: {
    id: "gml/undefined-function",
    name: "UndefinedFunction",
    category: "correctness",
    severity: "error",
    precision: "high",
    tier: "default",
    short: "Call to a function that does not exist.",
    full: "The called name is not a built-in function, a script function, an extension function, or a variable holding a method anywhere in the project. GameMaker will fail to compile or throw at runtime.",
    help: `A function is called that cannot be found anywhere in the project: it is not a GameMaker built-in (for the runtimes this scanner knows), not declared with \`function\` in a script, not an extension function, and no variable with that name is ever assigned (which rules out method variables).

This is usually a typo, a function that was renamed or deleted, or a GameMaker Studio 1.x function that no longer exists.

**How to fix:** correct the name, restore the missing script, or replace the legacy call with its modern equivalent.

\`\`\`gml
// Bad
instance_create(x, y, obj_bullet);      // removed in GameMaker Studio 2
scr_playr_hurt(10);                     // typo

// Good
instance_create_layer(x, y, "Instances", obj_bullet);
scr_player_hurt(10);
\`\`\``,
  },
  file(ctx) {
    if (!ctx.index.project.yyp) return; // without a .yyp the asset list is incomplete
    const reported = new Set<string>();
    const check = (callee: A.Expression, isNew: boolean) => {
      if (callee.type !== "Identifier") return;
      const name = callee.name;
      const ref = ctx.scopes.refOf.get(callee);
      if (!ref || ref.binding.kind !== "free" || reported.has(name)) return;
      const { index } = ctx;
      if (index.isKnownFunction(name) || index.isKnownGlobal(name) || index.assignedNames.has(name)) return;
      if (ctx.config.globalPrefixes.some((p) => name.startsWith(p))) return;
      reported.add(name);
      const legacy = LEGACY_REPLACEMENTS[name];
      const message = legacy
        ? `${code(name)} was removed in GameMaker Studio 2; use ${legacy} instead.`
        : `Undefined ${isNew ? "constructor" : "function"} ${code(name)}: no built-in, script function, extension function or method variable has this name.`;
      ctx.report(callee, message);
    };
    return {
      CallExpression: (n) => check(n.callee, false),
      NewExpression: (n) => check(n.callee, true),
    };
  },
};

export const runtimeUnavailableFunction: Rule = {
  meta: {
    id: "gml/runtime-unavailable",
    name: "RuntimeUnavailable",
    category: "correctness",
    severity: "error",
    precision: "very-high",
    tier: "default",
    short: "Built-in function does not exist in the project's target runtime.",
    full: "The function exists in some GameMaker runtime, but not in the runtime this project targets (from the .yyp IDEVersion or the `runtime` setting).",
    help: `The project targets a GameMaker runtime (read from \`MetaData.IDEVersion\` in the .yyp, or the \`runtime\` config option) in which this function does not exist. It was either added in a later release or removed.

The check only runs when the scanner has function data for the project's release line: the bundled LTS 2022 and LTS 2026 data, or an installed runtime passed with \`runtime-dir\` (\`--runtime-dir\` on the command line).

**How to fix:** upgrade the project's runtime, or use an alternative available in your runtime. If the target runtime is wrong, set \`"runtime"\` in \`.gmlscan.json\`.`,
  },
  file(ctx) {
    const rt = ctx.index.runtimeIndex;
    if (rt < 0) return;
    return {
      CallExpression(n) {
        if (n.callee.type !== "Identifier") return;
        const ref = ctx.scopes.refOf.get(n.callee);
        if (ref && ref.binding.kind !== "free") return;
        const fn = getBuiltinFunction(n.callee.name);
        if (!fn || availableInRuntime(fn.runtimeMask, rt) || ctx.index.globalFunctions.has(fn.name) || ctx.index.assignedNames.has(fn.name)) return;
        ctx.report(n.callee, `${code(fn.name)} is not available in GameMaker runtime ${KNOWN_RUNTIMES[rt]} (this project's target).`);
      },
    };
  },
};

function jsdocOptionalParams(fn: FunctionInfo): Set<string> {
  // `/// @param {Real} [name]` marks a parameter optional (Feather/JSDoc convention).
  const out = new Set<string>();
  const text = fn.file.source.text;
  let i = fn.node.start;
  const lines: string[] = [];
  while (i > 0) {
    const lineStart = text.lastIndexOf("\n", i - 2) + 1;
    const line = text.slice(lineStart, i).trim();
    if (!line.startsWith("//")) break;
    lines.push(line);
    i = lineStart;
  }
  for (const l of lines) {
    const m = /@(?:param|arg|argument)\s+(?:\{[^}]*\}\s*)?\[([A-Za-z_]\w*)/.exec(l);
    if (m) out.add(m[1]);
  }
  return out;
}

function handlesMissingArgument(fn: FunctionInfo, param: string): boolean {
  let handled = false;
  walk(fn.node.body, (n, c) => {
    if (handled) return c.skip();
    if (n.type === "Identifier" && n.name === "argument_count") handled = true;
    else if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "is_undefined" && n.arguments[0]?.type === "Identifier" && n.arguments[0].name === param) handled = true;
    else if (n.type === "BinaryExpression" && (n.operator === "??" || n.operator === "==" || n.operator === "!=")) {
      const sides = [n.left, n.right];
      if (sides.some((s) => s.type === "Identifier" && s.name === param) && (n.operator === "??" || sides.some((s) => s.type === "Identifier" && s.name === "undefined"))) handled = true;
    } else if (n.type === "AssignmentExpression" && n.operator === "??=" && n.left.type === "Identifier" && n.left.name === param) handled = true;
  });
  return handled;
}

export const wrongArgumentCount: Rule = {
  meta: {
    id: "gml/wrong-argument-count",
    name: "WrongArgumentCount",
    category: "correctness",
    severity: "error",
    precision: "high",
    tier: "default",
    short: "Function called with the wrong number of arguments.",
    full: "Built-in functions reject calls with too few or too many arguments at compile time. For script functions, extra arguments are silently ignored and missing required ones arrive as `undefined`.",
    help: `GameMaker checks argument counts for built-in functions: calling one with too few or too many arguments is a compile error.

For your own functions, extra arguments are ignored (unless the function reads \`argument[n]\`), and missing arguments become \`undefined\`, which usually causes a crash later. A parameter counts as optional when it has a default value (\`function f(a, b = 0)\`), is documented as optional (\`/// @param [b]\`), or the function checks it with \`is_undefined\`, \`??\` or \`argument_count\`.

\`\`\`gml
// Bad
draw_text(x, y);                 // missing the string argument
scr_damage(other, 10, true);     // scr_damage(target, amount) ignores "true"

// Good
draw_text(x, y, "Hello");
scr_damage(other, 10);
\`\`\``,
  },
  file(ctx) {
    const checkCall = (n: A.CallExpression | A.NewExpression) => {
      if (n.callee.type !== "Identifier") return;
      const name = n.callee.name;
      const ref = ctx.scopes.refOf.get(n.callee);
      if (!ref || ref.binding.kind !== "free") return;
      const argc = n.arguments.length;
      const { index } = ctx;
      const userFns = index.globalFunctions.get(name);
      if (!userFns && n.type === "CallExpression" && !index.assignedNames.has(name)) {
        const fn = getBuiltinFunction(name);
        if (fn) {
          if (argc < fn.minArgs) ctx.report(n, `Missing required argument for function ${code(name)}: expected at least ${plural(fn.minArgs, "argument")}, got ${argc}.`);
          else if (fn.maxArgs >= 0 && argc > fn.maxArgs) ctx.report(n.arguments[fn.maxArgs], `Too many arguments for function ${code(name)}: expected at most ${fn.maxArgs}, got ${argc}.`);
          return;
        }
        const ext = index.project.extensionFunctions.get(name);
        if (ext && ext.argCount >= 0 && argc !== ext.argCount) {
          ctx.report(n, `Extension function ${code(name)} is declared with ${plural(ext.argCount, "argument")} in ${ext.extension}, but called with ${argc}.`, { severity: "note" });
        }
        return;
      }
      if (!userFns || userFns.length !== 1) return;
      const fn = userFns[0];
      const params = fn.node.params;
      if (argc > params.length && !fn.scope.usesArguments) {
        ctx.report(n.arguments[params.length], `Extra argument for function ${code(name)}: it declares ${plural(params.length, "parameter")} but is called with ${argc}.`, { severity: "warning" });
        return;
      }
      if (argc < params.length) {
        const optional = jsdocOptionalParams(fn);
        const missing = params.slice(argc).find((p) => !p.init && !optional.has(p.id.name) && !handlesMissingArgument(fn, p.id.name));
        if (missing) ctx.report(n, `Missing required argument ${code(missing.id.name)} for function ${code(name)}.`, { severity: "warning" });
      }
    };
    return { CallExpression: checkCall, NewExpression: checkCall };
  },
};

export const deprecatedFunction: Rule = {
  meta: {
    id: "gml/deprecated",
    name: "DeprecatedBuiltin",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Use of a deprecated or obsolete built-in.",
    full: "The built-in function or variable is marked obsolete by GameMaker and may be removed or behave differently in newer runtimes.",
    help: `GameMaker marks this function or variable as obsolete. Obsolete built-ins may be removed in future runtimes, are often slower, and are hidden from autocomplete.

**How to fix:** switch to the replacement listed in the GameMaker manual. Common ones:

| Obsolete | Replacement |
| --- | --- |
| \`array_length_1d(a)\` | \`array_length(a)\` |
| \`array_height_2d(a)\` | \`array_length(a)\` |
| \`room_speed\` | \`game_get_speed(gamespeed_fps)\` / \`game_set_speed()\` |
| \`view_xview[0]\` | \`camera_get_view_x(view_camera[0])\` |
| \`draw_set_blend_mode\` | \`gpu_set_blendmode\` |`,
  },
  file(ctx) {
    // One finding per deprecated name per file, with a count of the uses.
    const first = new Map<string, { node: A.Identifier; message: string; count: number }>();
    const add = (node: A.Identifier, message: string) => {
      const entry = first.get(node.name);
      if (entry) entry.count++;
      else first.set(node.name, { node, message, count: 1 });
    };
    return {
      "file:exit"() {
        for (const e of first.values()) ctx.report(e.node, e.count > 1 ? `${e.message} (${e.count} uses in this file)` : e.message);
      },
      Identifier(n) {
        const ref = ctx.scopes.refOf.get(n);
        if (!ref || ref.binding.kind !== "free" || ref.inMacro) return;
        const name = n.name;
        const { index } = ctx;
        if (index.globalFunctions.has(name) || index.macros.has(name) || index.assets.has(name)) return;
        if (ref.isCallee) {
          const fn = getBuiltinFunction(name);
          if (!fn?.deprecated || index.assignedNames.has(name)) return;
          if (!availableInRuntime(fn.runtimeMask, index.runtimeIndex)) return; // reported as runtime-unavailable
          const alt = LEGACY_REPLACEMENTS[name];
          add(n, `${code(name)} is deprecated${alt ? `; use ${alt} instead` : ""}.`);
        } else {
          const v = getBuiltinVariable(name);
          if (!v?.deprecated || index.assignedNames.has(name) || index.globalVariables.has(name)) return;
          const alt = LEGACY_REPLACEMENTS[name];
          add(n, `Built-in variable ${code(name)} is deprecated${alt ? `; use ${alt} instead` : ""}.`);
        }
      },
    };
  },
};

const OBJECT_ASSET = "objects";
const ASSET_PREFIXES: [string, string][] = [
  ["spr_", "sprite"],
  ["obj_", "object"],
  ["snd_", "sound"],
  ["sfx_", "sound"],
  ["mus_", "sound"],
  ["rm_", "room"],
  ["fnt_", "font"],
  ["shd_", "shader"],
  ["sh_", "shader"],
  ["scr_", "script"],
  ["bg_", "sprite"],
  ["ts_", "tile set"],
  ["tl_", "timeline"],
  ["seq_", "sequence"],
  ["pth_", "path"],
];

export const undefinedVariable: Rule = {
  meta: {
    id: "gml/undefined-variable",
    name: "UndeclaredVariable",
    category: "correctness",
    severity: "warning",
    precision: "high",
    tier: "default",
    short: "Variable is read but never assigned anywhere in the project.",
    full: "Reading a variable that is never set crashes with \"variable not set before reading it\". The name is not a local, built-in, asset, macro, enum, or any instance/struct/global variable assigned anywhere in the project.",
    help: `This variable is read, but nothing in the project ever assigns it: not as a local (\`var\`), an instance or struct variable, an object Variable Definition, a \`global.\` variable, a macro, an enum or an asset. At runtime GameMaker stops with *"variable ... not set before reading it"*.

It is usually a typo or a variable that was renamed in one place but not another.

**How to fix:** fix the spelling, or initialise the variable (usually in the Create event).

\`\`\`gml
// Create event
move_speed = 4;

// Step event (bad: typo)
x += move_sped;

// Step event (good)
x += move_speed;
\`\`\`

If your project defines globals by naming convention (for example everything prefixed \`g_\`), add the prefix to \`globalPrefixes\` in \`.gmlscan.json\`.`,
  },
  file(ctx) {
    if (!ctx.index.project.yyp) return; // without a .yyp the asset list is incomplete
    const reported = new Set<string>();
    const { index } = ctx;
    const known = (name: string) =>
      index.isKnownGlobal(name) || index.assignedNames.has(name) || ctx.config.globalPrefixes.some((p) => name.startsWith(p)) || index.project.extensionFunctions.has(name);
    return {
      Identifier(n) {
        const ref = ctx.scopes.refOf.get(n);
        if (!ref || ref.binding.kind !== "free" || ref.isCallee || ref.inMacro || ref.access === "write") return;
        if (known(n.name) || reported.has(n.name)) return;
        reported.add(n.name);
        const asset = ASSET_PREFIXES.find(([p]) => n.name.startsWith(p));
        if (asset) ctx.report(n, `${code(n.name)} looks like a ${asset[1]} name, but no ${asset[1]} with this name exists in the project (deleted or renamed?); reading it crashes with "variable not set".`);
        else ctx.report(n, `Undeclared variable ${code(n.name)}: it is read here but never assigned anywhere in the project.`);
      },
      MemberExpression(n) {
        if (n.object.type !== "Identifier") return;
        const parent = ctx.ancestors[ctx.ancestors.length - 1];
        const isWrite = parent?.type === "AssignmentExpression" && parent.left === n && parent.operator === "=";
        if (isWrite) return;
        const base = n.object.name;
        const prop = n.property.name;
        const baseRef = ctx.scopes.refOf.get(n.object);
        if (baseRef && baseRef.binding.kind !== "free") return;
        if (base === "global") {
          if (index.globalVariables.has(prop) || index.usesDynamicVariableNames || getBuiltinVariable(prop)) return;
          if (reported.has(`global.${prop}`)) return;
          reported.add(`global.${prop}`);
          ctx.report(n, `${code(`global.${prop}`)} is read here but never assigned anywhere in the project.`);
          return;
        }
        if (index.assets.get(base) !== OBJECT_ASSET) return;
        if (index.assignedNames.has(prop) || getBuiltinVariable(prop) || isBuiltinFunction(prop) || index.usesDynamicVariableNames) return;
        const key = `${base}.${prop}`;
        if (reported.has(key)) return;
        reported.add(key);
        ctx.report(n.property, `${code(key)}: no object assigns a variable named ${code(prop)}.`);
      },
    };
  },
};

export const uncapturedLocal: Rule = {
  meta: {
    id: "gml/uncaptured-local",
    name: "UncapturedLocal",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Nested function uses a local variable of the enclosing function.",
    full: "GML functions do not capture the local (`var`) variables of the function they are defined in. Inside the nested function the name refers to an instance or struct variable instead.",
    help: `GML has no closures. A function or method defined inside another function (for example a callback passed to \`array_foreach\`) **cannot see the outer function's \`var\` locals**. The name inside the callback refers to an instance or struct variable instead, which usually doesn't exist and crashes with *"variable not set before reading it"*.

**How to fix:** pass the value explicitly, bind it with \`method()\`, or keep it in a struct.

\`\`\`gml
// Bad
var total = 0;
array_foreach(scores, function(s) {
    total += s;          // not the local "total"
});

// Good
var ctx = { total: 0 };
array_foreach(scores, method(ctx, function(s) {
    total += s;          // "self" is ctx
}));

// Also good
var total = 0;
for (var i = 0; i < array_length(scores); i++) total += scores[i];
\`\`\``,
  },
  file(ctx) {
    const reported = new Set<string>();
    return {
      Identifier(n) {
        const ref = ctx.scopes.refOf.get(n);
        if (!ref || ref.binding.kind !== "uncaptured") return;
        const key = `${ref.binding.decl.id.start}:${ref.scope.node.start}`;
        if (reported.has(key)) return;
        reported.add(key);
        const declLine = ctx.locate(ref.binding.decl.id).startLine;
        ctx.report(n, `${code(n.name)} is a local variable of the enclosing function (line ${declLine}), but GML functions don't capture outer locals; here it refers to an instance or struct variable.`, {
          related: [{ location: ctx.locate(ref.binding.decl.id), message: `${code(n.name)} declared here` }],
        });
      },
    };
  },
};

export const stringNumberAddition: Rule = {
  meta: {
    id: "gml/string-number-addition",
    name: "StringNumberAddition",
    category: "correctness",
    severity: "error",
    precision: "high",
    tier: "default",
    short: "Adding a string and a number throws a runtime error.",
    full: "GML does not convert numbers to strings when using `+`. Concatenating a string with a number stops the game with \"unable to add a number to string\".",
    help: `Unlike JavaScript, GML does **not** convert numbers to strings with \`+\`. Adding a string and a number stops the game with *"unable to add a number to string"*.

**How to fix:** convert the number with \`string()\`, or use a template string.

\`\`\`gml
// Bad
draw_text(10, 10, "Score: " + score);
draw_text(10, 30, "X: " + x);

// Good
draw_text(10, 10, "Score: " + string(score));
draw_text(10, 30, $"X: {x}");
\`\`\``,
  },
  file(ctx) {
    const check = (node: A.Node, left: A.Expression, right: A.Expression) => {
      const l = staticType(left, ctx);
      const r = staticType(right, ctx);
      if ((l === "string" && r === "number") || (l === "number" && r === "string")) {
        const num = l === "number" ? left : right;
        ctx.report(node, `Adding a string and a number stops the game with "unable to add a number to string"; wrap the number in string(): ${code(`string(${ctx.file.source.text.slice(num.start, num.end)})`)}.`);
      }
    };
    return {
      BinaryExpression(n) {
        if (n.operator === "+") check(n, n.left, n.right);
      },
      AssignmentExpression(n) {
        if (n.operator === "+=") check(n, n.left, n.right);
      },
    };
  },
};

export const unreachableCode: Rule = {
  meta: {
    id: "gml/unreachable-code",
    name: "UnreachableCode",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Code after return/exit/break/continue/throw never runs.",
    full: "Statements that directly follow an unconditional `return`, `exit`, `break`, `continue` or `throw` in the same block can never execute.",
    help: `These statements come directly after an unconditional \`return\`, \`exit\`, \`break\`, \`continue\` or \`throw\`, so they never run. Often this is leftover debug code, or an \`exit\` that was meant to be inside an \`if\`.

\`\`\`gml
// Bad
if (hp <= 0)
    instance_destroy();
    exit;              // runs every time; everything below is dead
x += hspeed;

// Good
if (hp <= 0) {
    instance_destroy();
    exit;
}
x += hspeed;
\`\`\``,
  },
  file(ctx) {
    const checkList = (body: A.Statement[]) => {
      for (let i = 0; i < body.length - 1; i++) {
        if (!isTerminator(body[i])) continue;
        // A defensive `break` after `return`/`exit` (common in switch cases) is harmless.
        const next = body.slice(i + 1).find((s) => s.type !== "FunctionDeclaration" && s.type !== "MacroDeclaration" && s.type !== "EnumDeclaration" && s.type !== "EmptyStatement" && s.type !== "BreakStatement");
        if (next) ctx.report(next, "Unreachable code: it follows an unconditional exit from this block.");
        return;
      }
    };
    return {
      BlockStatement: (n) => checkList(n.body),
      Program: (n) => checkList(n.body),
      SwitchCase: (n) => checkList(n.body),
    };
  },
};

export const emptyStatementBody: Rule = {
  meta: {
    id: "gml/empty-statement-body",
    name: "EmptyStatementBody",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Stray semicolon makes an if/loop body empty.",
    full: "A semicolon directly after `if (...)`, `while (...)`, `for (...)`, `repeat (...)` or `with (...)` becomes the whole body; the following block always runs (or the loop never ends).",
    help: `A semicolon right after the condition is an empty statement, and it becomes the entire body. The block that follows is **not** controlled by the condition.

\`\`\`gml
// Bad: the block always runs
if (keyboard_check_pressed(vk_space)); {
    jump();
}

// Good
if (keyboard_check_pressed(vk_space)) {
    jump();
}
\`\`\``,
  },
  file(ctx) {
    const check = (body: A.Statement | null, what: string) => {
      if (body?.type === "EmptyStatement") ctx.report(body, `Empty ${what} body: the semicolon ends the statement, so the code after it is not controlled by the ${what}.`);
    };
    return {
      IfStatement: (n) => check(n.consequent, "if"),
      WhileStatement: (n) => check(n.body, "while"),
      ForStatement: (n) => check(n.body, "for"),
      RepeatStatement: (n) => check(n.body, "repeat"),
      WithStatement: (n) => check(n.body, "with"),
    };
  },
};

function isAlwaysTrue(e: A.Expression | null): boolean {
  if (!e) return true;
  return (e.type === "BooleanLiteral" && e.value) || (e.type === "NumberLiteral" && e.value >= 0.5);
}

function isAlwaysFalse(e: A.Expression): boolean {
  return (e.type === "BooleanLiteral" && !e.value) || (e.type === "NumberLiteral" && e.value < 0.5);
}

/** Does the loop body contain a way out: break (at this loop level), return, exit, throw, or game_end()? */
function loopHasExit(body: A.Statement): boolean {
  let found = false;
  const visit = (node: A.Node, loopDepth: number, switchDepth: number) => {
    if (found) return;
    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
        return;
      case "ReturnStatement":
      case "ExitStatement":
      case "ThrowStatement":
        found = true;
        return;
      case "BreakStatement":
        if (loopDepth === 0 && switchDepth === 0) found = true;
        return;
      case "CallExpression":
        if (node.callee.type === "Identifier" && (node.callee.name === "game_end" || node.callee.name === "game_restart")) found = true;
        break;
    }
    const isLoop = node.type === "WhileStatement" || node.type === "DoUntilStatement" || node.type === "ForStatement" || node.type === "RepeatStatement";
    forEachChild(node, (c) => visit(c, loopDepth + (isLoop ? 1 : 0), switchDepth + (node.type === "SwitchStatement" ? 1 : 0)));
  };
  visit(body, 0, 0);
  return found;
}

export const infiniteLoop: Rule = {
  meta: {
    id: "gml/infinite-loop",
    name: "InfiniteLoop",
    category: "correctness",
    severity: "error",
    precision: "high",
    tier: "default",
    short: "Loop can never terminate and will freeze the game.",
    full: "The loop condition is always true and the body contains no `break`, `return`, `exit` or `throw`. GameMaker is single-threaded, so the game hangs.",
    help: `The loop condition never becomes false and nothing inside the loop leaves it. GameMaker runs your code on the main thread, so the game freezes and has to be killed.

Note that \`break\` inside a \`switch\` exits the switch, not the surrounding loop.

\`\`\`gml
// Bad
while (true) {
    if (ready) break;   // fine
}
while (true) {
    x += 1;             // freezes
}

// Good: bound the loop or add an exit
repeat (100) { x += 1; }
\`\`\``,
  },
  file(ctx) {
    return {
      WhileStatement(n) {
        if (isAlwaysTrue(n.test) && !loopHasExit(n.body)) ctx.report(n.test, "Infinite loop: the condition is always true and the body never breaks out, which freezes the game.");
      },
      ForStatement(n) {
        if (isAlwaysTrue(n.test) && !loopHasExit(n.body)) ctx.report(n.test ?? n, "Infinite loop: this for loop has no terminating condition and the body never breaks out.");
      },
      DoUntilStatement(n) {
        if (isAlwaysFalse(n.test) && !loopHasExit(n.body)) ctx.report(n.test, "Infinite loop: `until` is always false and the body never breaks out.");
      },
    };
  },
};

export const selfAssignment: Rule = {
  meta: {
    id: "gml/self-assignment",
    name: "SelfAssignment",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Variable is assigned to itself.",
    full: "Assigning a variable to itself has no effect and usually indicates a typo (for example `x = x` instead of `x = other.x`).",
    help: `\`a = a\` does nothing. This is usually a typo, most often inside \`with\` where \`other.\` was forgotten.

\`\`\`gml
// Bad
with (obj_follower) {
    x = x;
}

// Good
with (obj_follower) {
    x = other.x;
}
\`\`\``,
  },
  file(ctx) {
    return {
      AssignmentExpression(n) {
        if (n.operator !== "=") return;
        const l = normalizeSelf(n.left);
        const r = normalizeSelf(n.right);
        if (!sameExpression(l, r) || !isSideEffectFree(n.right)) return;
        ctx.report(n, `${code(ctx.file.source.text.slice(n.left.start, n.left.end))} is assigned to itself; this has no effect.`);
      },
    };
  },
};

export const selfComparison: Rule = {
  meta: {
    id: "gml/self-comparison",
    name: "SelfComparison",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Expression is compared with itself.",
    full: "Comparing an expression with itself always gives the same result and usually indicates a copy-paste error.",
    help: `Comparing something with itself is always true (\`==\`, \`<=\`, \`>=\`) or always false (\`!=\`, \`<\`, \`>\`). This is almost always a copy-paste error.

\`\`\`gml
// Bad
if (other.team == other.team) { ... }

// Good
if (team == other.team) { ... }
\`\`\``,
  },
  file(ctx) {
    const ops = new Set(["==", "!=", "<", "<=", ">", ">="]);
    return {
      BinaryExpression(n) {
        if (!ops.has(n.operator) || !isSideEffectFree(n.left)) return;
        if (!sameExpression(normalizeSelf(n.left), normalizeSelf(n.right))) return;
        const always = n.operator === "==" || n.operator === "<=" || n.operator === ">=";
        ctx.report(n, `Comparing an expression with itself is always ${always ? "true" : "false"}.`);
      },
    };
  },
};

function caseKey(e: A.Expression, text: string): string | undefined {
  switch (e.type) {
    case "NumberLiteral":
      return `n:${e.value}`;
    case "StringLiteral":
      return `s:${e.value}`;
    case "BooleanLiteral":
      return `n:${e.value ? 1 : 0}`;
    case "Identifier":
      return `i:${e.name}`;
    case "MemberExpression":
      return `m:${text.slice(e.start, e.end).replace(/\s+/g, "")}`;
    case "UnaryExpression":
      return e.operator === "-" && e.argument.type === "NumberLiteral" ? `n:${-e.argument.value}` : undefined;
    default:
      return undefined;
  }
}

export const duplicateCase: Rule = {
  meta: {
    id: "gml/duplicate-case",
    name: "DuplicateCase",
    category: "correctness",
    severity: "warning",
    precision: "very-high",
    tier: "default",
    short: "Switch has the same case label twice.",
    full: "Only the first matching case runs; the duplicate case body is unreachable.",
    help: `Two \`case\` labels in the same \`switch\` have the same value. Only the first one can ever match, so the second body is dead code. Usually one of them should be a different value.

\`\`\`gml
switch (state) {
    case STATE.IDLE: ...; break;
    case STATE.IDLE: ...; break;   // Bad: meant STATE.RUN
}
\`\`\``,
  },
  file(ctx) {
    return {
      SwitchStatement(n) {
        const seen = new Map<string, A.Expression>();
        for (const c of n.cases) {
          if (!c.test) continue;
          const key = caseKey(c.test, ctx.file.source.text);
          if (!key) continue;
          const first = seen.get(key);
          if (first) ctx.report(c.test, `Duplicate case label ${code(ctx.file.source.text.slice(c.test.start, c.test.end))}; only the first case with this value can match.`, { related: [{ location: ctx.locate(first), message: "First occurrence" }] });
          else seen.set(key, c.test);
        }
      },
    };
  },
};

export const divisionByZero: Rule = {
  meta: {
    id: "gml/division-by-zero",
    name: "DivisionByZero",
    category: "correctness",
    severity: "error",
    precision: "very-high",
    tier: "default",
    short: "Division or modulo by the constant zero.",
    full: "Dividing by zero (`/`, `div`, `mod`, `%`) stops the game with a \"Divide by zero\" error.",
    help: `Dividing by the literal \`0\` with \`/\`, \`div\`, \`mod\` or \`%\` stops the game with *"DoDiv :: Divide by zero"* (or DoMod).

**How to fix:** divide by the intended value, or guard the division.`,
  },
  file(ctx) {
    const isZero = (e: A.Expression) => e.type === "NumberLiteral" && e.value === 0;
    return {
      BinaryExpression(n) {
        if ((n.operator === "/" || n.operator === "%" || n.operator === "div") && isZero(n.right)) ctx.report(n, `Division by zero (${code(n.rawOperator + " 0")}) stops the game with a runtime error.`);
      },
      AssignmentExpression(n) {
        if ((n.operator === "/=" || n.operator === "%=") && isZero(n.right)) ctx.report(n, `Division by zero (${code(n.operator + " 0")}) stops the game with a runtime error.`);
      },
    };
  },
};

export const readonlyAssignment: Rule = {
  meta: {
    id: "gml/readonly-assignment",
    name: "ReadonlyAssignment",
    category: "correctness",
    severity: "error",
    precision: "high",
    tier: "default",
    short: "Assignment to a read-only built-in variable or constant.",
    full: "GameMaker rejects assignments to read-only built-in variables (such as `fps`, `id`, `object_index`) and constants.",
    help: `This built-in variable or constant is read-only. GameMaker reports a compile error (or ignores the write, depending on the target).

**How to fix:** use the setter function, if one exists (for example \`game_set_speed()\` instead of writing to \`fps\`), or use a different variable name for your own data.`,
  },
  file(ctx) {
    const check = (target: A.Expression) => {
      const t = normalizeSelf(target);
      if (t.type !== "Identifier") return;
      if (t !== target) {
        // self.x: property identifier has no ref
      } else {
        const ref = ctx.scopes.refOf.get(t);
        if (!ref || ref.binding.kind !== "free") return;
      }
      const v = getBuiltinVariable(t.name);
      if (!v || !v.readonly) return;
      if (ctx.index.macros.has(t.name) || ctx.index.enums.has(t.name)) return;
      ctx.report(target, `${code(t.name)} is a read-only built-in ${v.constant ? "constant" : "variable"}.`);
    };
    return {
      AssignmentExpression: (n) => check(n.left),
      UpdateExpression: (n) => check(n.argument),
    };
  },
};

export const globalScopeSelf: Rule = {
  meta: {
    id: "gml/global-scope-self",
    name: "GlobalScopeSelf",
    category: "correctness",
    severity: "warning",
    precision: "high",
    tier: "default",
    short: "`self`/`other` used in script global scope.",
    full: "Code at the top level of a script (outside any function) runs once at game start in global scope, where `self` and `other` refer to the global struct.",
    help: `Since GameMaker Studio 2.3, code at the top level of a script (outside any \`function\`) runs **once at game start in global scope**. There, \`self\` and \`other\` refer to the global struct, not an instance. That is almost never intended.

**How to fix:** move the code into a function, or use \`global.\` explicitly.

\`\`\`gml
// scr_player (bad): runs once at game start, "self" is global
self.hp = 100;

// good
function player_init() {
    hp = 100;
}
\`\`\``,
  },
  file(ctx) {
    if (ctx.file.kind !== "script") return;
    return {
      Identifier(n) {
        if (n.name !== "self" && n.name !== "other") return;
        const ref = ctx.scopes.refOf.get(n);
        if (!ref || ref.binding.kind !== "free" || ref.scope !== ctx.scopes.root || ref.withDepth > 0 || ref.inMacro) return;
        ctx.report(n, `${code(n.name)} refers to the global scope here, which is probably unintentional.`);
      },
    };
  },
};

export const CORRECTNESS_RULES: Rule[] = [
  undefinedFunction,
  runtimeUnavailableFunction,
  wrongArgumentCount,
  deprecatedFunction,
  undefinedVariable,
  uncapturedLocal,
  stringNumberAddition,
  unreachableCode,
  emptyStatementBody,
  infiniteLoop,
  selfAssignment,
  selfComparison,
  duplicateCase,
  divisionByZero,
  readonlyAssignment,
  globalScopeSelf,
];
