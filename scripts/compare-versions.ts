/**
 * Compares two semver versions by precedence. The release workflow runs it as
 *   node scripts/compare-versions.ts <a> <b>
 * which prints -1 (a is older), 0 (same) or 1 (a is newer).
 */

function parse(version: string): { core: number[]; pre: string[] } {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) throw new Error(`Not a semver version: ${version}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1; // numeric identifiers sort before alphanumeric ones
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  // A pre-release sorts before its release: 1.0.0-beta.1 < 1.0.0.
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdentifiers(x.pre[i], y.pre[i]);
    if (order !== 0) return order;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: node scripts/compare-versions.ts <a> <b>");
    process.exit(2);
  }
  console.log(compareVersions(a, b));
}
