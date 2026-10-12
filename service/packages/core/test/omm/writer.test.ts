import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOmmWriter, splitElementPath } from '../../src/omm/index.js';
import { listNodes, listPerspectives, readNodeField, showNode } from '../../src/upstream/index.js';
import { cleanupTmp, makeTmp } from '../agent/helpers.js';

afterEach(cleanupTmp);

describe('splitElementPath', () => {
  it('splits valid paths and rejects invalid ones', () => {
    expect(splitElementPath('a')).toEqual({ perspective: 'a', nodePath: [] });
    expect(splitElementPath('a/b/c')).toEqual({ perspective: 'a', nodePath: ['b', 'c'] });
    for (const p of ['', '../a', 'a/../b', '/a', 'A', 'a//b']) expect(() => splitElementPath(p), p).toThrow();
  });
});

describe('createOmmWriter', () => {
  it('writes through upstream into <outDir>/.omm and reads back', () => {
    const out = makeTmp();
    const w = createOmmWriter(out);
    expect(w.ommDir).toBe(path.join(out, '.omm'));
    expect(w.write('p', 'description', 'root')).toBe(4);
    expect(w.write('p/a/b', 'diagram', 'graph LR\n x["X"] -->|"y"| z["Z"]')).toBeGreaterThan(0);
    expect(w.read('p', 'description')).toBe('root');
    expect(w.read('p/a/b', 'description')).toBeNull();
    expect(w.perspectives()).toEqual(['p']);
    expect(w.list()).toEqual(['p']);
    expect(w.list('p')).toEqual(['a']);
    expect(w.list('p/a')).toEqual(['b']);
    expect(w.allElementPaths()).toEqual(['p', 'p/a', 'p/a/b']);
    // Same data through the upstream API directly.
    expect(listPerspectives(out)).toEqual(['p']);
    expect(listNodes('p', ['a'], out)).toEqual(['b']);
    expect(readNodeField('p', [], 'description', out)).toBe('root');
    expect(showNode('p', ['a', 'b'], out)?.meta?.title).toBe('b');
  });

  it('does not write anything outside .omm and is quiet on stderr', () => {
    const out = makeTmp();
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      createOmmWriter(out).write('p/q', 'note', 'n');
    } finally {
      process.stderr.write = original;
    }
    expect(written).toEqual([]);
    expect(process.stderr.write).toBe(original);
    expect(fs.readdirSync(out)).toEqual(['.omm']);
  });

  it('restores stderr even when upstream throws', () => {
    const out = makeTmp();
    const original = process.stderr.write;
    expect(() => createOmmWriter(out).write('Bad Path', 'note', 'n')).toThrow();
    expect(process.stderr.write).toBe(original);
  });

  it('rejects unknown fields and bad paths before touching disk', () => {
    const out = makeTmp();
    const w = createOmmWriter(out);
    expect(() => w.write('p', 'exec' as never, 'x')).toThrow();
    expect(() => w.write('../x', 'note', 'x')).toThrow();
    expect(fs.existsSync(path.join(out, '.omm'))).toBe(false);
  });

  it('lists nothing for a missing tree and sets the language in config.yaml', () => {
    const out = makeTmp();
    const w = createOmmWriter(out);
    expect(w.perspectives()).toEqual([]);
    expect(w.allElementPaths()).toEqual([]);
    w.setLanguage('ko');
    expect(fs.readFileSync(path.join(out, '.omm', 'config.yaml'), 'utf-8')).toContain('language: ko');
    w.setLanguage('en');
    const cfg = fs.readFileSync(path.join(out, '.omm', 'config.yaml'), 'utf-8');
    expect(cfg).toContain('language: en');
    expect(cfg).toContain('version:');
  });
});
