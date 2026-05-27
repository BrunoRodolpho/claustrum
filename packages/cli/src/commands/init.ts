/* eslint-disable no-console -- CLI command writes user-facing stdout/stderr. */
/**
 * `claustrum init <name>` — scaffold a new adopter project from the
 * `templates/adopter/` directory.
 *
 * The scaffolded project ships a working `createConductor()` factory
 * wired entirely from in-memory test doubles (no API keys required to
 * boot), an `.env.example` listing the variables a production adopter
 * would set, and a README quickstart pointing at `claustrum conformance`
 * and `claustrum replay`.
 */

import * as path from "node:path";
import chalk from "chalk";
import { renderTemplate } from "../lib/template.js";

export interface InitOptions {
  /** Override the parent directory the project is created under. */
  readonly target?: string;
  /** Override cwd (test injection point). */
  readonly cwd?: string;
  /** Override the templates root (test injection point). */
  readonly templatesRoot?: string;
  /**
   * When false, the function returns instead of calling `process.exit`.
   * Used by tests to drive the path without leaking exit codes.
   */
  readonly exitOnError?: boolean;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

function toPascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("");
}

function deriveVars(name: string): Readonly<Record<string, string>> {
  return {
    projectName: name,
    className: toPascalCase(name),
  };
}

export interface InitResult {
  readonly ok: boolean;
  readonly targetDir?: string;
  readonly error?: string;
  readonly written?: ReadonlyArray<string>;
}

export async function runInit(
  name: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const exitOnError = options.exitOnError ?? true;

  if (!isValidName(name)) {
    const msg = `Invalid project name "${name}". Must match ${NAME_PATTERN}.`;
    if (exitOnError) {
      console.error(chalk.red("X"), msg);
      process.exit(1);
    }
    return { ok: false, error: msg };
  }

  const cwd = options.cwd ?? process.cwd();
  const targetParent = options.target ?? cwd;
  const targetDir = path.join(targetParent, name);
  const vars = deriveVars(name);

  console.log(chalk.dim("•"), "target:", chalk.cyan(targetDir));
  console.log(chalk.dim("•"), "Scaffolding adopter project…");

  try {
    const result = await renderTemplate({
      templateDir: "adopter",
      targetDir,
      vars,
      ...(options.templatesRoot !== undefined
        ? { templatesRoot: options.templatesRoot }
        : {}),
    });
    console.log(
      chalk.green("ok"),
      `Scaffolded ${chalk.bold(name)} (${result.written.length} files)`,
    );
    console.log();
    console.log(chalk.dim("Next steps:"));
    console.log(chalk.dim("  cd"), targetDir);
    console.log(chalk.dim("  pnpm install"));
    console.log(
      chalk.dim("  pnpm conformance     # run the runtime invariant suite"),
    );
    console.log(
      chalk.dim("  pnpm dev             # boot the scaffolded conductor"),
    );
    return { ok: true, targetDir, written: result.written };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (exitOnError) {
      console.error(chalk.red("X"), e.message);
      process.exit(1);
    }
    return { ok: false, error: e.message, targetDir };
  }
}
