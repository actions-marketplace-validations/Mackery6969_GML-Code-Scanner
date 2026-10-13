import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareVersions } from "../scripts/compare-versions.ts";

describe("compareVersions", () => {
  it("orders release versions numerically", () => {
    assert.equal(compareVersions("1.0.3", "1.0.4"), -1);
    assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
    assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
    assert.equal(compareVersions("1.2.3", "v1.2.3"), 0);
  });

  it("sorts a pre-release before its release", () => {
    assert.equal(compareVersions("1.1.0-beta.1", "1.1.0"), -1);
    assert.equal(compareVersions("1.1.0", "1.1.0-beta.1"), 1);
    assert.equal(compareVersions("1.0.3", "1.1.0-beta.1"), -1);
  });

  it("orders pre-release identifiers by semver precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < ordered.length; i++) {
      assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} < ${ordered[i]}`);
      assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1, `${ordered[i]} > ${ordered[i - 1]}`);
    }
  });

  it("rejects anything that isn't a version", () => {
    assert.throws(() => compareVersions("1.0", "1.0.0"), /Not a semver version/);
  });
});
