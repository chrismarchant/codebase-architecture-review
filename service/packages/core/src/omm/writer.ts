/**
 * Thin wrapper over the upstream `.omm/` store bound to one output directory.
 *
 * All file-format knowledge (meta.yaml, directory layout, field file names) stays in
 * upstream; this module only maps a service element path ("perspective/child/…") onto
 * upstream's `(perspective, nodePath)` arguments and pins `cwd` to the output directory,
 * so the tool host can never write anywhere except `<outDir>/.omm`.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ElementPath, OmmField } from '@archreview/contracts';
import * as upstream from '../upstream/index.js';

export interface OmmWriter {
  /** Output directory that contains `.omm/`. */
  readonly outDir: string;
  /** Absolute path of `<outDir>/.omm`. */
  readonly ommDir: string;
  write(elementPath: string, field: OmmField, content: string): number;
  read(elementPath: string, field: OmmField): string | null;
  /** Child element names under `elementPath`; with no path, the perspectives. */
  list(elementPath?: string): string[];
  perspectives(): string[];
  /** Every element path currently on disk (perspectives and all descendants), sorted. */
  allElementPaths(): string[];
  /** Records the content language in `.omm/config.yaml` (what `omm config language <x>` does). */
  setLanguage(language: string): void;
}

/** Splits and validates "perspective/child/…" into upstream's arguments. */
export function splitElementPath(elementPath: string): { perspective: string; nodePath: string[] } {
  const parsed = ElementPath.parse(elementPath);
  const [perspective, ...nodePath] = parsed.split('/');
  return { perspective: perspective as string, nodePath };
}

/**
 * Upstream's writeNodeField reports every write on stderr ("wrote …"), which is useful for a
 * CLI and noise for a service. The call is synchronous, so swapping the writer for its
 * duration cannot interleave with other output.
 */
function quietly<T>(fn: () => T): T {
  const original = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return fn();
  } finally {
    process.stderr.write = original;
  }
}

export function createOmmWriter(outDir: string): OmmWriter {
  const absOut = path.resolve(outDir);
  const ommDir = path.join(absOut, '.omm');

  function list(elementPath?: string): string[] {
    if (elementPath === undefined || elementPath === '') return upstream.listPerspectives(absOut);
    const { perspective, nodePath } = splitElementPath(elementPath);
    return upstream.listNodes(perspective, nodePath, absOut);
  }

  function walk(prefix: string[], out: string[]): void {
    const children =
      prefix.length === 0 ? upstream.listPerspectives(absOut) : upstream.listNodes(prefix[0] as string, prefix.slice(1), absOut);
    for (const child of children) {
      const next = [...prefix, child];
      out.push(next.join('/'));
      walk(next, out);
    }
  }

  return {
    outDir: absOut,
    ommDir,
    write(elementPath, field, content) {
      OmmField.parse(field);
      const { perspective, nodePath } = splitElementPath(elementPath);
      return quietly(() => upstream.writeNodeField(perspective, nodePath, field, content, absOut));
    },
    read(elementPath, field) {
      OmmField.parse(field);
      const { perspective, nodePath } = splitElementPath(elementPath);
      return upstream.readNodeField(perspective, nodePath, field, absOut);
    },
    list,
    perspectives: () => upstream.listPerspectives(absOut),
    allElementPaths() {
      const out: string[] = [];
      walk([], out);
      return out.sort();
    },
    setLanguage(language) {
      quietly(() => upstream.initOmm(absOut));
      const file = path.join(ommDir, 'config.yaml');
      const config = (YAML.parse(fs.readFileSync(file, 'utf-8')) ?? {}) as Record<string, unknown>;
      config.language = language;
      fs.writeFileSync(file, YAML.stringify(config), 'utf-8');
    },
  };
}
