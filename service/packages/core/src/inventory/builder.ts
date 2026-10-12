/**
 * Stage 3: walk the read-only snapshot and produce `inventory.json` (SS00 §3.2, §8.1).
 *
 * Decisions:
 *  - Binary files (NUL in the first 8 KiB) are listed under `excluded` with reason `binary`; `files` holds
 *    only content the agent can usefully read. Their bytes still appear in the snapshot hash (the exporter's).
 *  - Default exclude globs match at any depth (gitignore style), so `packages/x/dist/a.js` is excluded too.
 *  - Lockfiles are included but tagged with language `lockfile`.
 *  - Files already excluded by the exporter are never re-listed as files.
 */
import { createHash } from 'node:crypto';
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { AnalysisBudgets, Inventory, RepoRelativePath, SCHEMA_IDS } from '@archreview/contracts';
import { languageForPath } from './language.js';

type InventoryT = Inventory;
type ExcludedEntry = InventoryT['excluded'][number];

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = ['node_modules/**', 'vendor/**', 'dist/**', 'build/**', '.git/**', '*.min.js'];
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Compile a small glob dialect (`*` within a segment, `**` across segments, `?`) to a regex. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function compileExcludeGlobs(globs: readonly string[]): (relPath: string) => boolean {
  const regs = globs.map(globToRegExp);
  return (relPath) => {
    const segs = relPath.split('/');
    // match the whole path and every trailing sub-path, so patterns apply at any depth
    for (let i = 0; i < segs.length; i++) {
      const tail = segs.slice(i).join('/');
      if (regs.some((r) => r.test(tail))) return true;
    }
    return false;
  };
}

export function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

export interface BuildInventoryOptions {
  commitSha: string;
  /** from the exporter; covers every extracted file, including ones the globs drop here */
  snapshotSha256: string;
  budgets?: Pick<AnalysisBudgets, 'maxFileBytes'>;
  excludeGlobs?: readonly string[];
  now?: Date;
}

export async function buildInventory(
  snapshotDir: string,
  excludedFromExport: ReadonlyArray<ExcludedEntry>,
  o: BuildInventoryOptions,
): Promise<InventoryT> {
  const root = path.resolve(snapshotDir);
  const maxFileBytes = o.budgets?.maxFileBytes ?? AnalysisBudgets.parse({}).maxFileBytes;
  const isGlobExcluded = compileExcludeGlobs(o.excludeGlobs ?? DEFAULT_EXCLUDE_GLOBS);
  const alreadyExcluded = new Set(excludedFromExport.map((e) => e.path));

  const files: InventoryT['files'] = [];
  const excluded: ExcludedEntry[] = excludedFromExport.map((e) => ({ ...e }));
  const byLanguage: Record<string, number> = {};
  let totalBytes = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    const dir = await opendir(absDir);
    const children: Array<{ name: string; isDir: boolean; isFile: boolean; isLink: boolean }> = [];
    for await (const d of dir) children.push({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile(), isLink: d.isSymbolicLink() });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const rel = relDir === '' ? child.name : `${relDir}/${child.name}`;
      const abs = path.join(absDir, child.name);
      if (child.isLink) {
        excluded.push({ path: rel, reason: 'symlink' }); // the exporter never writes links; defence in depth
      } else if (child.isDir) {
        await walk(abs, rel);
      } else if (child.isFile) {
        if (alreadyExcluded.has(rel)) continue;
        await visitFile(abs, rel);
      } else {
        excluded.push({ path: rel, reason: 'special_file' });
      }
    }
  }

  async function visitFile(abs: string, rel: string): Promise<void> {
    // O_NOFOLLOW-free open is safe here: the dirent said regular file and the tree is read-only and link-free.
    const fh = await open(abs, 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile()) {
        excluded.push({ path: rel, reason: 'special_file' });
        return;
      }
      const bytes = st.size;
      if (isGlobExcluded(rel)) {
        excluded.push({ path: rel, reason: 'glob_exclude', bytes });
        return;
      }
      if (!RepoRelativePath.safeParse(rel).success) {
        excluded.push({ path: rel, reason: 'unsafe_path', bytes });
        return;
      }
      if (bytes > maxFileBytes) {
        excluded.push({ path: rel, reason: 'over_file_byte_cap', bytes });
        return;
      }
      const buf = bytes === 0 ? Buffer.alloc(0) : await fh.readFile();
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        excluded.push({ path: rel, reason: 'binary', bytes: buf.length });
        return;
      }
      const language = languageForPath(rel);
      files.push({
        path: rel,
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        language,
        lines: countLines(buf),
      });
      totalBytes += buf.length;
      const key = language ?? 'unknown';
      byLanguage[key] = (byLanguage[key] ?? 0) + 1;
    } finally {
      await fh.close();
    }
  }

  await walk(root, '');

  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  files.sort((a, b) => cmp(a.path, b.path));
  excluded.sort((a, b) => cmp(a.path, b.path) || cmp(a.reason, b.reason));

  return Inventory.parse({
    schema: SCHEMA_IDS.inventory,
    commitSha: o.commitSha,
    snapshotSha256: o.snapshotSha256,
    files,
    excluded,
    totals: { files: files.length, bytes: totalBytes, byLanguage: Object.fromEntries(Object.entries(byLanguage).sort(([a], [b]) => cmp(a, b))) },
    generatedAt: (o.now ?? new Date()).toISOString(),
  });
}
