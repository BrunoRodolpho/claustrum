/**
 * CC-006 — few-shot-regression.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fewShotRegressionCheck } from "../src/index.js";
import { makeTestConductor } from "./make-conductor.js";

async function makeTempFixtureDir(
  files: ReadonlyArray<{ name: string; content: object }>,
): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cc006-"));
  for (const f of files) {
    await fs.writeFile(
      path.join(base, f.name),
      JSON.stringify(f.content, null, 2),
      "utf8",
    );
  }
  return base;
}

describe("CC-006 few-shot-regression", () => {
  it("passes vacuously when fixtures directory is empty", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cc006-empty-"));
    const { conductor } = makeTestConductor();
    const result = await fewShotRegressionCheck.run(conductor, {
      fixturesDir: empty,
    });
    expect(result.passed).toBe(true);
    expect(result.details ?? "").toContain("No few-shot fixtures discovered");
  });

  it("passes when fixtures match observed envelope kinds + decision", async () => {
    const dir = await makeTempFixtureDir([
      {
        name: "echo.json",
        content: {
          id: "echo",
          scenario: "Normal echo",
          conversation: [
            { role: "user", content: "hello there" },
            { role: "assistant", content: "Echo: hello there" },
          ],
          expectedEnvelopeKinds: ["demo.echo"],
          expectedDecisionKind: "EXECUTE",
        },
      },
      {
        name: "danger.json",
        content: {
          id: "danger",
          scenario: "Refusal path",
          conversation: [{ role: "user", content: "do something danger" }],
          expectedEnvelopeKinds: ["danger"],
          expectedDecisionKind: "REFUSE",
        },
      },
    ]);
    const { conductor } = makeTestConductor();
    const result = await fewShotRegressionCheck.run(conductor, {
      fixturesDir: dir,
    });
    expect(result.passed).toBe(true);
    expect(result.details ?? "").toContain("Verified 2");
  });

  it("fails when an expected decision diverges from observed", async () => {
    const dir = await makeTempFixtureDir([
      {
        name: "wrong-expectation.json",
        content: {
          id: "wrong",
          scenario: "expectation diverges from observed",
          conversation: [{ role: "user", content: "hi" }],
          expectedEnvelopeKinds: ["demo.echo"],
          // The conductor returns EXECUTE; we expect REFUSE → mismatch.
          expectedDecisionKind: "REFUSE",
        },
      },
    ]);
    const { conductor } = makeTestConductor();
    const result = await fewShotRegressionCheck.run(conductor, {
      fixturesDir: dir,
    });
    expect(result.passed).toBe(false);
    expect(result.details ?? "").toContain("expected REFUSE");
  });
});
