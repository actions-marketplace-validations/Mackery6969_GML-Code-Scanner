/**
 * Reads a GameMaker runtime's `GmlSpec.xml` and `fnames`: the built-in functions,
 * variables and constants it defines. Used by scripts/gen-builtins.ts to build the
 * bundled database, and at scan time for an installed runtime (`--runtime-dir`).
 *
 * GmlSpec.xml provides typed signatures; fnames fills in everything GmlSpec omits
 * (platform functions, obsolete names, instance variables).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// Function flags
export const F_DEPRECATED = 1;
export const F_PURE = 2;
// Variable / constant flags
export const V_DEPRECATED = 1;
export const V_READONLY = 2;
export const V_INSTANCE = 4;

export interface RuntimeSpec {
  version: string;
  /** The runtime folder it was read from. */
  dir: string;
  functions: Map<string, [minArgs: number, maxArgs: number, returnType: string, flags: number]>;
  variables: Map<string, [type: string, flags: number]>;
  constants: Map<string, [type: string, flags: number]>;
  enums: Map<string, string[]>;
}

export class RuntimeSpecError extends Error {}

function attr(tag: string, name: string): string | undefined {
  // Safe: every caller passes a hardcoded attribute name literal.
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

function readGmlSpec(file: string, rt: RuntimeSpec, overwrite: boolean): void {
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

function readFnames(file: string, rt: RuntimeSpec): void {
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

/** The runtime version of an installed runtime: from its folder name, else its receipt.json. */
function runtimeVersion(dir: string): string | undefined {
  const fromName = /(\d+\.\d+\.\d+\.\d+)$/.exec(basename(dir.replace(/[\\/]+$/, "")))?.[1];
  if (fromName) return fromName;
  try {
    const receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")) as { base?: { Version?: string } };
    return receipt.base?.Version;
  } catch {
    return undefined;
  }
}

/** Loads an installed runtime (a `runtime-<version>` folder with GmlSpec.xml and/or fnames). */
export function loadRuntimeSpec(dir: string): RuntimeSpec {
  if (!existsSync(dir)) throw new RuntimeSpecError(`The runtime folder ${dir} doesn't exist.`);
  const version = runtimeVersion(dir);
  if (!version) throw new RuntimeSpecError(`Can't tell which GameMaker runtime ${dir} is: name the folder runtime-<version> (e.g. runtime-2023.1.1.81).`);
  const rt: RuntimeSpec = { version, dir, functions: new Map(), variables: new Map(), constants: new Map(), enums: new Map() };
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
  if (!found) throw new RuntimeSpecError(`No GmlSpec.xml or fnames in ${dir}. Point it at an installed runtime folder (runtime-<version>).`);
  return rt;
}
