/** Local test helpers (no dependency on the core `testing` module). */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTreeWritable } from '../../src/retrieval/safe-extract.js';

const created: string[] = [];

export function tmpDir(prefix = 'archreview-test'): string {
  const d = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  created.push(d);
  return d;
}

export async function cleanupTmp(): Promise<void> {
  for (const d of created.splice(0)) {
    await makeTreeWritable(d).catch(() => undefined);
    rmSync(d, { recursive: true, force: true });
  }
}

/** Executable wrapper around git, for fault injection and observation. `body` runs before `exec git "$@"`. */
export function gitWrapper(dir: string, body: string, name = 'git-wrapper'): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\nexec git "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

export interface TreeEntry {
  rel: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  mode: number;
}

export function walkTree(root: string, rel = ''): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const r = rel === '' ? name : `${rel}/${name}`;
    const st = lstatSync(path.join(root, r));
    const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    out.push({ rel: r, type, mode: st.mode & 0o777 });
    if (type === 'dir') out.push(...walkTree(root, r));
  }
  return out;
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------------------
// Minimal ustar writer for hand-crafted hostile archives
// ---------------------------------------------------------------------------
export interface TarSpec {
  name: string;
  type?: '0' | '1' | '2' | '3' | '4' | '5' | '6';
  data?: string | Buffer;
  linkname?: string;
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

export function buildTar(entries: TarSpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(octal(0o644, 8), 100, 8, 'ascii');
    h.write(octal(0, 8), 108, 8, 'ascii');
    h.write(octal(0, 8), 116, 8, 'ascii');
    h.write(octal(data.length, 12), 124, 12, 'ascii');
    h.write(octal(0, 12), 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write(e.type ?? '0', 156, 1, 'ascii');
    if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(octal(sum, 7).slice(0, 6) + '\0 ', 148, 8, 'ascii');
    blocks.push(h);
    if (data.length > 0) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
