/**
 * `claustrum init` — name validation + template rendering.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Templates live at packages/cli/templates relative to the package root.
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_ROOT = path.join(PACKAGE_ROOT, "templates");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claustrum-init-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("runInit", () => {
  it("rejects invalid project names", async () => {
    const result = await runInit("Invalid Name!", {
      target: tmpRoot,
      templatesRoot: TEMPLATES_ROOT,
      exitOnError: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("Invalid project name");
  });

  it("rejects names starting with a digit", async () => {
    const result = await runInit("9bad", {
      target: tmpRoot,
      templatesRoot: TEMPLATES_ROOT,
      exitOnError: false,
    });
    expect(result.ok).toBe(false);
  });

  it("scaffolds a project from the adopter template", async () => {
    const result = await runInit("demo-app", {
      target: tmpRoot,
      templatesRoot: TEMPLATES_ROOT,
      exitOnError: false,
    });
    expect(result.ok).toBe(true);
    expect(result.targetDir).toBe(path.join(tmpRoot, "demo-app"));
    expect((result.written ?? []).length).toBeGreaterThanOrEqual(4);
    const pkgPath = path.join(tmpRoot, "demo-app", "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("demo-app");
    const srcPath = path.join(tmpRoot, "demo-app", "src", "index.ts");
    const src = await fs.readFile(srcPath, "utf8");
    // Variable substitution worked.
    expect(src).toContain("demo-app");
    expect(src).toContain("DemoApp"); // PascalCase
  });

  it("refuses to clobber an existing directory with conflicting files", async () => {
    await fs.mkdir(path.join(tmpRoot, "demo-app"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "demo-app", "package.json"),
      '{"name":"existing"}',
      "utf8",
    );
    const result = await runInit("demo-app", {
      target: tmpRoot,
      templatesRoot: TEMPLATES_ROOT,
      exitOnError: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("already exists");
  });
});
