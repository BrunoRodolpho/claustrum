/**
 * Runner-level tests — confirm `runConformance()` returns a report shape
 * matching the contract, threads options through, and falls back to
 * `DEFAULT_CHECKS` when no checks are supplied.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKS,
  runConformance,
  type ConformanceCheck,
  type ConformanceResult,
} from "../src/index.js";
import { makeTestConductor } from "./make-conductor.js";

describe("runConformance()", () => {
  it("returns a report with summary = total/passed/failed", async () => {
    const { conductor } = makeTestConductor();
    const report = await runConformance(conductor, { sampling: 5 });
    expect(report.summary.total).toBe(DEFAULT_CHECKS.length);
    expect(report.summary.passed + report.summary.failed).toBe(
      report.summary.total,
    );
    expect(report.passed).toBe(report.summary.failed === 0);
  });

  it("returns DEFAULT_CHECKS results when no checks override is supplied", async () => {
    const { conductor } = makeTestConductor();
    const report = await runConformance(conductor, { sampling: 3 });
    expect(report.results.map((r) => r.id)).toEqual(
      DEFAULT_CHECKS.map((c) => c.id),
    );
  });

  it("uses custom check set when supplied", async () => {
    const customCheck: ConformanceCheck = {
      id: "X-001",
      name: "custom",
      async run(): Promise<ConformanceResult> {
        return { id: "X-001", name: "custom", passed: true, details: "ok" };
      },
    };
    const { conductor } = makeTestConductor();
    const report = await runConformance(conductor, { checks: [customCheck] });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.id).toBe("X-001");
    expect(report.passed).toBe(true);
  });

  it("catches throws from individual checks and reports them as failed", async () => {
    const throwingCheck: ConformanceCheck = {
      id: "X-THROW",
      name: "throws",
      async run(): Promise<ConformanceResult> {
        throw new Error("boom");
      },
    };
    const { conductor } = makeTestConductor();
    const report = await runConformance(conductor, { checks: [throwingCheck] });
    expect(report.passed).toBe(false);
    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.details).toContain("boom");
  });
});
