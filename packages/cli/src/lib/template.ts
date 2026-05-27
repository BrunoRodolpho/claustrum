/**
 * Template renderer.
 *
 * Templates live under `packages/cli/templates/<name>/`. Template files
 * end with the `.tmpl` suffix, which is stripped at render time. The
 * renderer copies the directory tree, reads each file, substitutes
 * `${var}` markers from the supplied `vars` map, and writes the
 * rendered file at the target.
 *
 * Substitution is a deliberate `String.prototype.replaceAll` chain — no
 * Handlebars / Mustache dep. Placeholders are documented per template
 * file at the top.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Templates ship adjacent to the source. After build, they live next to
 * `dist/`; in dev (`tsx` loading source), they live next to `src/`. The
 * relative walk is identical in both layouts.
 */
function defaultTemplatesRoot(): string {
  // From `packages/cli/src/lib/template.ts` → `../../templates`
  // From `packages/cli/dist/lib/template.js` → `../../templates`
  return path.resolve(__dirname, "..", "..", "templates");
}

export type TemplateVars = Readonly<Record<string, string>>;

export interface RenderTemplateOptions {
  /** Template directory name (relative to the templates root). */
  readonly templateDir: string;
  readonly targetDir: string;
  readonly vars: TemplateVars;
  /**
   * When true, fails if any target file already exists. Default `true` —
   * `claustrum init` should not silently clobber existing files.
   */
  readonly failOnConflict?: boolean;
  /** Override the templates root (test injection point). */
  readonly templatesRoot?: string;
}

export interface RenderResult {
  readonly written: ReadonlyArray<string>;
}

function substitute(content: string, vars: TemplateVars): string {
  let out = content;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`\${${key}}`, value);
  }
  return out;
}

async function* walkDir(root: string, relPrefix = ""): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const rel = path.join(relPrefix, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, rel);
    } else if (entry.isFile()) {
      yield rel;
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function renderTemplate(
  opts: RenderTemplateOptions,
): Promise<RenderResult> {
  const root = opts.templatesRoot ?? defaultTemplatesRoot();
  const templateDir = path.join(root, opts.templateDir);
  const failOnConflict = opts.failOnConflict ?? true;
  const written: string[] = [];

  if (!(await fileExists(templateDir))) {
    throw new Error(
      `[template] template directory not found: ${templateDir}`,
    );
  }

  await fs.mkdir(opts.targetDir, { recursive: true });

  for await (const rel of walkDir(templateDir)) {
    const sourcePath = path.join(templateDir, rel);
    const relStripped = rel.endsWith(".tmpl") ? rel.slice(0, -5) : rel;
    const targetPath = path.join(opts.targetDir, relStripped);

    if (failOnConflict && (await fileExists(targetPath))) {
      throw new Error(
        `[template] target file already exists: ${targetPath}`,
      );
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const raw = await fs.readFile(sourcePath, "utf8");
    const rendered = substitute(raw, opts.vars);
    await fs.writeFile(targetPath, rendered, "utf8");
    written.push(targetPath);
  }

  return { written };
}
