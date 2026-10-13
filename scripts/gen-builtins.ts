/**
 * Generates src/semantic/builtins.json from one or more GameMaker runtimes.
 *
 * Usage: node scripts/gen-builtins.ts <runtimeDir> [<runtimeDir> ...]
 *
 * Each runtime directory must contain `GmlSpec.xml` and/or `fnames`, e.g. an
 * installed runtime (C:\ProgramData\GameMakerStudio2\Cache\runtimes\runtime-2024.x)
 * or the output of scripts/fetch-runtime-spec.ts. Directory names must end in the
 * runtime version (`runtime-2023.1.1.81`).
 *
 * GmlSpec.xml provides typed signatures; fnames fills in everything GmlSpec omits
 * (platform functions, obsolete names, instance variables). Every symbol records a
 * bitmask of the runtimes that define it, so the scanner can report functions that
 * do not exist in a project's target runtime.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type FunctionEntry = [minArgs: number, maxArgs: number, returnType: string, flags: number, runtimeMask: number];
type VariableEntry = [type: string, flags: number, runtimeMask: number];

// Function flags
const F_DEPRECATED = 1;
const F_PURE = 2;
// Variable / constant flags
const V_DEPRECATED = 1;
const V_READONLY = 2;
const V_INSTANCE = 4;

interface RuntimeData {
  version: string;
  functions: Map<string, [minArgs: number, maxArgs: number, returnType: string, flags: number]>;
  variables: Map<string, [string, number]>;
  constants: Map<string, [string, number]>;
  enums: Map<string, string[]>;
}

function attr(tag: string, name: string): string | undefined {
  // Safe: every caller passes a hardcoded attribute name literal; this is an offline dev script.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readGmlSpec(file: string, rt: RuntimeData, overwrite: boolean): void {
  const xml = readFileSync(file, "utf8");
  for (const m of xml.matchAll(/<Function\s[^>]*?(?:\/>|>([\s\S]*?)<\/Function>)/g)) {
    const tag = m[0].slice(0, m[0].indexOf(">") + 1);
    const name = attr(tag, "Name");
    if (!name || (!overwrite && rt.functions.has(name))) continue;
    let min = 0;
    let max = 0;
    for (const p of (m[1] ?? "").matchAll(/<Parameter\s[^>]*>/g)) {
      const optional = attr(p[0], "Optional") === "true";
      if (attr(p[0], "Name") === "...") {
        if (!optional) min++;
        max = -1;
        break;
      }
      max++;
      if (!optional) min = max;
    }
    let flags = 0;
    if (attr(tag, "Deprecated") === "true") flags |= F_DEPRECATED;
    if (attr(tag, "Pure") === "true") flags |= F_PURE;
    rt.functions.set(name, [min, max, attr(tag, "ReturnType") ?? "Any", flags]);
  }
  for (const m of xml.matchAll(/<Variable\s[^>]*>/g)) {
    const name = attr(m[0], "Name");
    if (!name || (!overwrite && rt.variables.has(name))) continue;
    let flags = 0;
    if (attr(m[0], "Deprecated") === "true") flags |= V_DEPRECATED;
    if (attr(m[0], "Set") === "false") flags |= V_READONLY;
    if (attr(m[0], "Instance") === "true") flags |= V_INSTANCE;
    rt.variables.set(name, [attr(m[0], "Type") ?? "Any", flags]);
  }
  for (const m of xml.matchAll(/<Constant\s[^>]*>/g)) {
    const name = attr(m[0], "Name");
    if (!name || name.startsWith("$$") || (!overwrite && rt.constants.has(name))) continue;
    rt.constants.set(name, [attr(m[0], "Type") ?? "Any", attr(m[0], "Deprecated") === "true" ? V_DEPRECATED : 0]);
  }
  for (const m of xml.matchAll(/<Enumeration\s[^>]*>([\s\S]*?)<\/Enumeration>/g)) {
    const name = attr(m[0].slice(0, m[0].indexOf(">") + 1), "Name");
    if (!name) continue;
    rt.enums.set(name, [...m[1].matchAll(/<Member\s[^>]*>/g)].map((mm) => attr(mm[0], "Name")!).filter(Boolean));
  }
}

function readFnames(file: string, rt: RuntimeData): void {
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("??")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\((.*)\))?(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, sig, args, , rest] = m;
    const flagChars = rest.split("^")[0];
    const obsolete = flagChars.includes("&");
    if (flagChars.includes("?")) continue; // struct field, not a global identifier
    if (sig !== undefined) {
      const existing = rt.functions.get(name);
      if (existing) {
        if (obsolete) existing[3] |= F_DEPRECATED;
        continue;
      }
      let min = 0;
      let max = 0;
      for (const part of args.split(",").map((a) => a.trim()).filter(Boolean)) {
        if (part === "...") {
          max = -1;
          break;
        }
        max++;
        if (!part.startsWith("[")) min = max;
      }
      rt.functions.set(name, [min, max, "Any", obsolete ? F_DEPRECATED : 0]);
    } else if (flagChars.includes("#")) {
      const existing = rt.constants.get(name);
      if (existing) {
        if (obsolete) existing[1] |= V_DEPRECATED;
      } else {
        rt.constants.set(name, ["Any", obsolete ? V_DEPRECATED : 0]);
      }
    } else {
      const existing = rt.variables.get(name);
      if (existing) {
        if (obsolete) existing[1] |= V_DEPRECATED;
        if (flagChars.includes("@")) existing[1] |= V_INSTANCE;
        continue;
      }
      let flags = 0;
      if (obsolete) flags |= V_DEPRECATED;
      if (flagChars.includes("*")) flags |= V_READONLY;
      if (flagChars.includes("@")) flags |= V_INSTANCE;
      rt.variables.set(name, ["Any", flags]);
    }
  }
}

function loadRuntime(dir: string): RuntimeData {
  const version = /(\d+\.\d+\.\d+\.\d+)\/?$/.exec(dir.replace(/\\/g, "/"))?.[1];
  if (!version) {
    console.error(`Cannot determine runtime version from directory name: ${dir}`);
    process.exit(1);
  }
  const rt: RuntimeData = { version, functions: new Map(), variables: new Map(), constants: new Map(), enums: new Map() };
  let found = false;
  // Base spec first; the Opera GX folder only adds GX-specific symbols.
  for (const sub of ["", "operagx"]) {
    const spec = join(dir, sub, "GmlSpec.xml");
    const fnames = join(dir, sub, "fnames");
    if (existsSync(spec)) {
      readGmlSpec(spec, rt, sub === "");
      found = true;
    }
    if (existsSync(fnames)) {
      readFnames(fnames, rt);
      found = true;
    }
  }
  if (!found) {
    console.error(`No GmlSpec.xml or fnames found in ${dir}`);
    process.exit(1);
  }
  return rt;
}

const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: node scripts/gen-builtins.ts <runtimeDir> [<runtimeDir> ...]");
  process.exit(1);
}

// Newest runtime first: its signatures and flags win.
const runtimes = dirs.map(loadRuntime).sort((a, b) => compareVersions(b.version, a.version));

const functions = new Map<string, FunctionEntry>();
const variables = new Map<string, VariableEntry>();
const constants = new Map<string, VariableEntry>();
const enums = new Map<string, string[]>();

runtimes.forEach((rt, i) => {
  const bit = 1 << i;
  const newest = i === 0;
  for (const [name, entry] of rt.functions) {
    const existing = functions.get(name);
    if (existing) existing[4] |= bit;
    // A symbol missing from the newest runtime has been removed: mark it deprecated.
    else functions.set(name, [entry[0], entry[1], entry[2], entry[3] | (newest ? 0 : F_DEPRECATED), bit]);
  }
  for (const [target, source] of [
    [variables, rt.variables],
    [constants, rt.constants],
  ] as const) {
    for (const [name, entry] of source) {
      const existing = target.get(name);
      if (existing) existing[2] |= bit;
      else target.set(name, [entry[0], entry[1] | (newest ? 0 : V_DEPRECATED), bit]);
    }
  }
  for (const [name, members] of rt.enums) if (!enums.has(name)) enums.set(name, members);
});

const sortObj = <T>(m: Map<string, T>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const out = {
  $comment: "Generated by scripts/gen-builtins.ts from GameMaker runtime GmlSpec.xml + fnames. Do not edit by hand.",
  /** Bit i of each entry's runtime mask refers to runtimes[i]. */
  runtimes: runtimes.map((r) => r.version),
  functions: sortObj(functions),
  variables: sortObj(variables),
  constants: sortObj(constants),
  enums: sortObj(enums),
};

// One entry per line keeps diffs readable when regenerating for a new runtime.
const json = JSON.stringify(out).replace(/\],"/g, '],\n"').replace(/:\{"/g, ':{\n"');
writeFileSync(new URL("../src/semantic/builtins.json", import.meta.url), json + "\n");
console.log(
  `Wrote ${functions.size} functions, ${variables.size} variables, ${constants.size} constants, ${enums.size} enums from ${out.runtimes.join(", ")}`,
);
