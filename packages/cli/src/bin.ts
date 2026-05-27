#!/usr/bin/env node
/**
 * `claustrum` CLI entry point.
 *
 * Three subcommands:
 *   - init <name> [--target <dir>]       — scaffold an adopter project
 *   - replay <turnId> --conductor ... --turn ... [--format text|json]
 *   - conformance --conductor ... [--seed N] [--sampling N] [--format text|json]
 */

import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runReplay } from "./commands/replay.js";
import { runConformanceCommand } from "./commands/conformance.js";

const program = new Command();

program
  .name("claustrum")
  .description(
    "claustrum runtime CLI — scaffold adopters, replay turns, run the conformance suite.",
  )
  .version("0.1.0");

program
  .command("init <name>")
  .description("Scaffold a new adopter project from the canonical template")
  .option(
    "--target <dir>",
    "Override the parent directory the project is created under (defaults to cwd)",
  )
  .action(async (name: string, options: { target?: string }) => {
    await runInit(name, {
      ...(options.target !== undefined ? { target: options.target } : {}),
    });
  });

program
  .command("replay <turnId>")
  .description(
    "Replay a recorded turn through a freshly-loaded conductor; report divergence",
  )
  .requiredOption(
    "--conductor <module>",
    "Path to a module exporting `createConductor`",
  )
  .requiredOption(
    "--turn <file>",
    "JSON file describing the turn (channel, customerId, text, expectedDecisionKind, ...)",
  )
  .option("--format <text|json>", "Output format. Defaults to text", "text")
  .action(
    async (
      turnId: string,
      options: { conductor: string; turn: string; format?: string },
    ) => {
      const format = (options.format ?? "text") as "text" | "json";
      if (format !== "text" && format !== "json") {
        console.error(
          `Unknown --format "${options.format}". Use text or json.`,
        );
        process.exit(1);
      }
      await runReplay(turnId, {
        conductor: options.conductor,
        turn: options.turn,
        format,
      });
    },
  );

program
  .command("conformance")
  .description(
    "Run the @claustrum/conformance invariant suite against an adopter conductor",
  )
  .requiredOption(
    "--conductor <module>",
    "Path to a module exporting `createConductor`",
  )
  .option("--seed <n>", "PRNG seed (default 42)")
  .option("--sampling <n>", "Sample count per fuzz check (default 100)")
  .option("--format <text|json>", "Output format. Defaults to text", "text")
  .action(
    async (options: {
      conductor: string;
      seed?: string;
      sampling?: string;
      format?: string;
    }) => {
      const format = (options.format ?? "text") as "text" | "json";
      if (format !== "text" && format !== "json") {
        console.error(
          `Unknown --format "${options.format}". Use text or json.`,
        );
        process.exit(1);
      }
      const seed =
        options.seed !== undefined ? Number(options.seed) : undefined;
      const sampling =
        options.sampling !== undefined ? Number(options.sampling) : undefined;
      if (seed !== undefined && !Number.isFinite(seed)) {
        console.error(`--seed must be a finite number, got "${options.seed}".`);
        process.exit(1);
      }
      if (
        sampling !== undefined &&
        (!Number.isFinite(sampling) || sampling < 1)
      ) {
        console.error(
          `--sampling must be a positive integer, got "${options.sampling}".`,
        );
        process.exit(1);
      }
      await runConformanceCommand({
        conductor: options.conductor,
        ...(seed !== undefined ? { seed } : {}),
        ...(sampling !== undefined ? { sampling } : {}),
        format,
      });
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
