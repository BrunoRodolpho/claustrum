/* eslint-disable no-console -- CLI command writes user-facing stdout/stderr. */
/**
 * `claustrum conformance --conductor <module>` — load the adopter's
 * conductor and run `runConformance` against it.
 *
 * Output formats:
 *   text — human-readable, one line per check + final pass/fail
 *   json — full `ConformanceReport` for tooling
 *
 * Exit codes:
 *   0 — every check passed
 *   1 — one or more checks failed, or loading the conductor threw
 */

import chalk from "chalk";
import {
  runConformance,
  type ConformanceReport,
} from "@claustrum/conformance";
import type { Conductor } from "@claustrum/core";
import { loadConductorFactory } from "../lib/load-conductor.js";

export interface ConformanceCommandOptions {
  readonly conductor: string;
  readonly seed?: number;
  readonly sampling?: number;
  readonly format?: "text" | "json";
  /** Test-injection point. */
  readonly cwd?: string;
  /** When false, return instead of calling process.exit. */
  readonly exitOnError?: boolean;
}

export interface ConformanceCommandResult {
  readonly ok: boolean;
  readonly report?: ConformanceReport;
  readonly error?: string;
}

export async function runConformanceCommand(
  options: ConformanceCommandOptions,
): Promise<ConformanceCommandResult> {
  const exitOnError = options.exitOnError ?? true;
  const format = options.format ?? "text";
  const cwd = options.cwd ?? process.cwd();

  let conductor: Conductor;
  try {
    const loaded = await loadConductorFactory(options.conductor, cwd);
    conductor = await loaded.factory();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: ConformanceCommandResult = { ok: false, error: msg };
    if (format === "json") console.log(JSON.stringify(result, null, 2));
    else console.error(chalk.red("X"), msg);
    if (exitOnError) process.exit(1);
    return result;
  }

  const report = await runConformance(conductor, {
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.sampling !== undefined ? { sampling: options.sampling } : {}),
  });

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of report.results) {
      const marker = r.passed ? chalk.green("ok") : chalk.red("X");
      console.log(marker, chalk.bold(r.id), r.name);
      if (r.details !== undefined && r.details.length > 0) {
        console.log(chalk.dim("   "), chalk.dim(r.details));
      }
    }
    console.log();
    const summary = report.passed
      ? chalk.green(`All ${report.summary.total} checks passed.`)
      : chalk.red(
          `${report.summary.failed} / ${report.summary.total} checks failed.`,
        );
    console.log(summary);
  }

  if (!report.passed && exitOnError) process.exit(1);
  return { ok: report.passed, report };
}
