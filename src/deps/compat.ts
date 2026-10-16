/**
 * Decides whether a release works with the GameMaker version a project targets.
 *
 * Evidence, strongest first:
 * - the IDE a .yymps package was exported from (its metadata.json `ide_version`): an older
 *   IDE can't import resources saved by a newer one;
 * - a minimum stated in the release notes ("used with GM 2023.1 and future releases");
 * - the GameMaker Marketplace's per-version labels (GMS1, GMS2, GMS2.3).
 * With none of these, compatibility is unknown and the update isn't raised as an alert.
 */
import type { PackageMetadata, Release } from "./sources.ts";
import { compareGameMaker, parseVersion } from "./version.ts";

export interface Requirement {
  /** Oldest GameMaker version (year.release.patch) the release works with. */
  minimum?: string;
  /** Only for GameMaker Studio 2.2 and older (Marketplace GMS1/GMS2 versions). */
  legacyOnly?: boolean;
  /** Why, for messages: "exported from GameMaker 2022.0.1", "release notes: GM 2023.1 and future releases". */
  basis: string[];
}

const GM_VERSION = String.raw`(\d{4}\.\d+(?:\.\d+){0,2}|2\.3(?:\.\d+){0,2})`;
const GM_NAME = String.raw`(?:GM|GMS2?|GameMaker(?:\s+Studio(?:\s*2)?)?|runtime|IDE)`;

/** "GM 2023.1 and future releases", "GameMaker 2024.11+", "runtime 2024.2 or later". */
const FLOOR_AFTER = new RegExp(String.raw`\b${GM_NAME}\s*v?${GM_VERSION}\s*(?:LTS\w*\s*)?(?:\+|\(?\s*(?:and|or)\s+(?:all\s+)?(?:future|later|newer|above|higher|greater|up)\b)`, "gi");
/** "requires GameMaker 2024.11", "minimum runtime: 2024.2". */
const FLOOR_BEFORE = new RegExp(String.raw`\b(?:requires?|required|minimum|needs?|at least)\b[^.\n]{0,30}?\b${GM_NAME}\s*(?:version\s*)?:?\s*v?${GM_VERSION}`, "gi");

/** Minimum GameMaker versions stated in release notes, oldest first. */
export function floorsFromNotes(notes: string | undefined): { version: string; text: string }[] {
  if (!notes) return [];
  const out = new Map<string, string>();
  for (const re of [FLOOR_AFTER, FLOOR_BEFORE]) {
    for (const m of notes.matchAll(re)) if (!out.has(m[1])) out.set(m[1], m[0].trim().replace(/\s+/g, " "));
  }
  return [...out].map(([version, text]) => ({ version, text })).sort((a, b) => compareGameMaker(a.version, b.version));
}

/** Three-part form of a GameMaker version, for messages: 2022.0.1.0 → 2022.0.1. */
export function shortGameMaker(version: string): string {
  return (parseVersion(version)?.core ?? []).slice(0, 3).join(".");
}

export function requirementOf(release: Release, metadata?: PackageMetadata): Requirement | undefined {
  if (release.label) {
    if (/^GMS2\.3/i.test(release.label)) return { minimum: "2.3.0", basis: [`Marketplace version for ${release.label}+`] };
    if (/^GMS?[12]$/i.test(release.label)) return { legacyOnly: true, basis: [`Marketplace version for ${release.label}`] };
  }
  const basis: string[] = [];
  let minimum: string | undefined;
  if (metadata?.ideVersion && parseVersion(metadata.ideVersion)) {
    minimum = shortGameMaker(metadata.ideVersion);
    basis.push(`exported from GameMaker ${minimum}`);
  }
  // Notes may name several floors ("LTS 2022.0.1 ... and 2023.1 and future releases"); the
  // lowest is the one the release promises, but it can't be lower than the export IDE.
  const floor = floorsFromNotes(release.notes)[0];
  if (floor) {
    if (!minimum || compareGameMaker(floor.version, minimum) > 0) minimum = floor.version;
    basis.push(`release notes: "${floor.text}"`);
  }
  return minimum ? { minimum, basis } : undefined;
}

/** true / false, or undefined when there's no evidence either way. */
export function isCompatible(requirement: Requirement | undefined, runtime: string | undefined): boolean | undefined {
  if (!requirement) return undefined;
  if (requirement.legacyOnly) return runtime ? compareGameMaker(runtime, "2.3.0") < 0 : false;
  if (!requirement.minimum || !runtime) return undefined;
  return compareGameMaker(runtime, requirement.minimum) >= 0;
}
