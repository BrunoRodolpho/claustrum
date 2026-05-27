/**
 * `loadConductorFactory(modulePath)` — dynamically import the adopter's
 * conductor factory.
 *
 * Convention: the adopter ships a CJS-compatible ES module that exports
 * `createConductor` as a function whose return value matches the
 * `Conductor` interface (or an async function whose resolved value
 * does). The CLI walks the absolute path, file-URLs it via Node's
 * `pathToFileURL`, dynamic-imports it, and extracts `createConductor`.
 *
 * Errors are thrown as plain Error instances with operator-readable
 * messages — the CLI commands catch and translate to red-X output.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Conductor } from "@claustrum/core";

export type ConductorFactory = () => Conductor | Promise<Conductor>;

export interface LoadedConductorFactory {
  readonly factory: ConductorFactory;
  /** The resolved absolute path of the imported module. */
  readonly modulePath: string;
}

export async function loadConductorFactory(
  modulePath: string,
  cwd: string = process.cwd(),
): Promise<LoadedConductorFactory> {
  const absolute = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(cwd, modulePath);
  const url = pathToFileURL(absolute).href;

  let imported: unknown;
  try {
    imported = await import(url);
  } catch (err) {
    throw new Error(
      `Failed to import conductor module at ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const mod = imported as Record<string, unknown>;
  const factory = mod["createConductor"] ?? (mod["default"] as Record<string, unknown> | undefined)?.["createConductor"];
  if (typeof factory !== "function") {
    throw new Error(
      `Module ${absolute} does not export a "createConductor" function. ` +
        `Expected: export function createConductor(): Conductor | Promise<Conductor>.`,
    );
  }

  return {
    factory: factory as ConductorFactory,
    modulePath: absolute,
  };
}
