import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const IGNORE_FILE_NAME = ".gmlscanignore";

export interface IgnoreRule {
  pattern: RegExp;
  negated: boolean;
  base: string;
}

export function parseIgnoreLine(line: string, base = ""): IgnoreRule | undefined {
  let text = line.replace(/(?<!\\)\s+$/, "");
  if (text === "" || text.startsWith("#")) return undefined;
  const negated = text.startsWith("!");
  if (negated) text = text.slice(1);
  text = text.replace(/^\\([#!])/, "$1").replace(/\\(\s)/g, "$1");
  const directoryOnly = text.endsWith("/");
  if (directoryOnly) text = text.replace(/\/+$/, "");
  if (text === "") return undefined;
  return { pattern: ignorePatternToRegExp(text, directoryOnly), negated, base };
}

export function ignorePatternToRegExp(glob: string, directoryOnly = false): RegExp {
  let source = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  const anchored = source.startsWith("/");
  if (anchored) source = source.slice(1);
  let body = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") {
      const slash = source[index + 2] === "/";
      body += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += /[.+^${}()|[\]\\]/.test(char ?? "") ? `\\${char}` : char;
  }
  const prefix = anchored || source.includes("/") ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${body}${directoryOnly ? "/.+" : "(?:/.*)?"}$`);
}

export function compileIgnoreLines(lines: string[], base = ""): IgnoreRule[] {
  return lines.flatMap((line) => parseIgnoreLine(line, base) ?? []);
}

export function matcherFor(rules: IgnoreRule[]): (relPath: string) => boolean {
  return (relPath) => {
    let ignored = false;
    for (const rule of rules) {
      const path = rule.base ? `${rule.base}/${relPath}` : relPath;
      if (rule.pattern.test(path)) ignored = !rule.negated;
    }
    return ignored;
  };
}

export function ignoreFileFolders(root: string): string[] {
  const folders: string[] = [];
  let folder = resolve(root);
  for (;;) {
    folders.push(folder);
    if (existsSync(join(folder, ".git"))) return folders.reverse();
    const parent = dirname(folder);
    if (parent === folder) return [resolve(root)];
    folder = parent;
  }
}

export function ignoreFileRules(root: string): IgnoreRule[] {
  const scanRoot = resolve(root);
  return ignoreFileFolders(scanRoot).flatMap((folder) => {
    const file = join(folder, IGNORE_FILE_NAME);
    if (!existsSync(file)) return [];
    const base = relative(folder, scanRoot).split(sep).join("/");
    return compileIgnoreLines(readFileSync(file, "utf8").split(/\r?\n/), base);
  });
}

export function loadIgnoreMatcher(root: string, configPatterns: string[]): (relPath: string) => boolean {
  return matcherFor([...ignoreFileRules(root), ...compileIgnoreLines(configPatterns)]);
}
