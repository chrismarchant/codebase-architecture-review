import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { componentIdFor, relationshipIdFor, EvidenceItem } from '@archreview/contracts';
import { ArchreviewToolHost, BudgetExceeded, ToolPolicyError, MAX_FIELD_BYTES } from '../../src/agent/index.js';
import { MINI_APP, cleanupTmp, makeHarness } from './helpers.js';

afterEach(cleanupTmp);

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolPolicyError) return e.code;
    if (e instanceof BudgetExceeded) return `budget:${e.budget}`;
    throw e;
  }
  return 'no-error';
};

describe('ommWrite', () => {
  it('writes a field under outDir/.omm and creates the tree through upstream', () => {
    const h = makeHarness(MINI_APP);
    expect(h.host.ommWrite('overall-architecture', 'description', 'hello')).toEqual({ bytes: 5 });
    expect(h.host.ommWrite('overall-architecture/http-api', 'description', 'api')).toEqual({ bytes: 3 });
    expect(fs.readFileSync(path.join(h.outDir, '.omm', 'overall-architecture', 'http-api', 'description.md'), 'utf-8')).toBe('api');
    expect(fs.existsSync(path.join(h.outDir, '.omm', 'config.yaml'))).toBe(true);
    expect(h.host.ommRead('overall-architecture/http-api', 'description')).toBe('api');
    expect(h.host.ommRead('overall-architecture/http-api', 'note')).toBeNull();
    expect(h.host.ommList()).toEqual(['overall-architecture']);
    expect(h.host.ommList('overall-architecture')).toEqual(['http-api']);
  });

  it('rejects invalid element paths', () => {
    const { host } = makeHarness(MINI_APP);
    for (const p of ['', '../../etc', '/etc/passwd', 'Upper', 'a//b', 'a/../b', 'a/b/', 'a b', '-lead', 'a\0b', 'x'.repeat(65)]) {
      expect(code(() => host.ommWrite(p, 'description', 'x')), p).toBe('invalid_element_path');
    }
    expect(code(() => host.ommRead('../x', 'description'))).toBe('invalid_element_path');
    expect(code(() => host.ommList('../x'))).toBe('invalid_element_path');
  });

  it('enforces maxDepth', () => {
    const { host } = makeHarness(MINI_APP, { maxDepth: 3 });
    expect(code(() => host.ommWrite('a/b/c', 'description', 'x'))).toBe('no-error');
    expect(code(() => host.ommWrite('a/b/c/d', 'description', 'x'))).toBe('depth_exceeded');
  });

  it('rejects unknown fields', () => {
    const { host } = makeHarness(MINI_APP);
    expect(code(() => host.ommWrite('a', 'exec' as never, 'x'))).toBe('invalid_field');
    expect(code(() => host.ommRead('a', 'meta' as never))).toBe('invalid_field');
  });

  it('enforces the content size limit in bytes and rejects NUL', () => {
    const { host } = makeHarness(MINI_APP);
    expect(code(() => host.ommWrite('a', 'note', 'x'.repeat(MAX_FIELD_BYTES)))).toBe('no-error');
    expect(code(() => host.ommWrite('a', 'note', 'x'.repeat(MAX_FIELD_BYTES + 1)))).toBe('content_too_large');
    // 3 bytes per character: under 64 KiB in characters, over in bytes.
    expect(code(() => host.ommWrite('a', 'note', '€'.repeat(Math.ceil(MAX_FIELD_BYTES / 3) + 1)))).toBe('content_too_large');
    expect(code(() => host.ommWrite('a', 'note', 'bad\0byte'))).toBe('invalid_content');
    expect(code(() => host.ommWrite('a', 'note', 5 as never))).toBe('invalid_content');
  });

  it('caps distinct elements and allows rewriting existing ones', () => {
    const h = makeHarness(MINI_APP, { maxElements: 3 });
    h.host.ommWrite('p', 'description', '1');
    h.host.ommWrite('p/a', 'description', '1');
    h.host.ommWrite('p/b', 'description', '1');
    h.host.ommWrite('p/b', 'diagram', 'graph LR\n a["A"] -->|"x"| b["B"]');
    h.host.ommWrite('p/a', 'note', 'again');
    expect(h.host.stats().elements).toBe(3);
    expect(code(() => h.host.ommWrite('p/c', 'description', '1'))).toBe('budget:maxElements');
    expect(fs.existsSync(path.join(h.outDir, '.omm', 'p', 'c'))).toBe(false);
    expect(h.host.stats().limitsHit).toContain('maxElements');
  });

  it('counts elements already on disk from an earlier attempt', () => {
    const h = makeHarness(MINI_APP, { maxElements: 2 });
    h.host.ommWrite('p', 'description', '1');
    h.host.ommWrite('p/a', 'description', '1');
    const again = new ArchreviewToolHost({ snapshotDir: h.snapshotDir, outDir: h.outDir, inventory: h.inventory, budgets: h.budgets });
    expect(again.stats().elements).toBe(2);
    expect(code(() => again.ommWrite('p/b', 'description', '1'))).toBe('budget:maxElements');
  });

  it('records the content language in config.yaml', () => {
    const h = makeHarness(MINI_APP);
    new ArchreviewToolHost({ snapshotDir: h.snapshotDir, outDir: h.outDir, inventory: h.inventory, budgets: h.budgets, language: 'de' });
    expect(fs.readFileSync(path.join(h.outDir, '.omm', 'config.yaml'), 'utf-8')).toMatch(/language: de/);
  });
});

describe('evidenceAdd', () => {
  const base = { elementPath: 'overall-architecture', claim: 'c', kind: 'observed' as const, confidence: 'high' as const };

  it('stores validated evidence with the file hash and a stable id', () => {
    const h = makeHarness(MINI_APP);
    const { id } = h.host.evidenceAdd({ ...base, refs: [{ file: 'src/server.ts', startLine: 1, endLine: 21 }] });
    expect(id).toMatch(/^e_[0-9a-f]{12}$/);
    const again = makeHarness(MINI_APP).host.evidenceAdd({ ...base, refs: [{ file: 'src/server.ts', startLine: 1, endLine: 21 }] });
    expect(again.id).toBe(id);
    const drained = h.host.drain();
    expect(drained.items).toHaveLength(1);
    const item = EvidenceItem.parse(drained.items[0]);
    expect(item.subject).toEqual({ componentId: componentIdFor('overall-architecture') });
    expect(item.refs[0]?.sha256).toBe(h.inventory.files.find((f) => f.path === 'src/server.ts')?.sha256);
  });

  it('is idempotent for an identical claim and counts distinct items', () => {
    const h = makeHarness(MINI_APP);
    h.host.evidenceAdd({ ...base, refs: [{ file: 'src/server.ts' }] });
    h.host.evidenceAdd({ ...base, refs: [{ file: 'src/server.ts' }] });
    h.host.evidenceAdd({ ...base, claim: 'other', refs: [{ file: 'src/server.ts' }] });
    expect(h.host.stats().evidenceItems).toBe(2);
  });

  it('rejects files that are not in the inventory, including traversal and absolute paths', () => {
    const { host } = makeHarness(MINI_APP);
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: 'src/nope.ts' }] }))).toBe('unknown_file');
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: '/etc/passwd' }] }))).toBe('invalid_ref');
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: '../x' }] }))).toBe('invalid_ref');
    expect(code(() => host.evidenceAdd({ ...base, refs: [] }))).toBe('invalid_ref');
  });

  it('validates line ranges against the file length', () => {
    const { host, inventory } = makeHarness(MINI_APP);
    const lines = inventory.files.find((f) => f.path === 'src/db/queries.ts')?.lines as number;
    expect(lines).toBe(4);
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: 'src/db/queries.ts', startLine: 1, endLine: lines }] }))).toBe('no-error');
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: 'src/db/queries.ts', startLine: 1, endLine: lines + 1 }] }))).toBe('invalid_line_range');
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: 'src/db/queries.ts', startLine: lines + 1 }] }))).toBe('invalid_line_range');
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: 'src/db/queries.ts', startLine: 3, endLine: 2 }] }))).toBe('invalid_line_range');
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: 'src/db/queries.ts', startLine: 0 }] }))).toBe('invalid_line_range');
    expect(code(() => host.evidenceAdd({ ...base, refs: [{ file: 'src/db/queries.ts', endLine: 2 }] }))).toBe('invalid_line_range');
  });

  it('rejects invalid kind, confidence, claim and element path', () => {
    const { host } = makeHarness(MINI_APP);
    const refs = [{ file: 'src/server.ts' }];
    expect(code(() => host.evidenceAdd({ ...base, refs, kind: 'fact' as never }))).toBe('invalid_kind');
    expect(code(() => host.evidenceAdd({ ...base, refs, confidence: 'sure' as never }))).toBe('invalid_confidence');
    expect(code(() => host.evidenceAdd({ ...base, refs, claim: '' }))).toBe('invalid_claim');
    expect(code(() => host.evidenceAdd({ ...base, refs, claim: 'x'.repeat(1025) }))).toBe('invalid_claim');
    expect(code(() => host.evidenceAdd({ ...base, refs, elementPath: '../x' }))).toBe('invalid_element_path');
  });

  it('keys relationship evidence by (declaredIn, fromPath, toPath, label)', () => {
    const h = makeHarness(MINI_APP);
    const relationship = { fromPath: 'p/a', toPath: 'p/b', label: 'calls' };
    const e1 = h.host.evidenceAdd({ ...base, elementPath: 'p', relationship, refs: [{ file: 'src/server.ts', startLine: 1 }] });
    const e2 = h.host.evidenceAdd({ ...base, elementPath: 'p', relationship, claim: 'second', refs: [{ file: 'src/config.ts', startLine: 1 }] });
    const drained = h.host.drain();
    expect(drained.relationships).toHaveLength(1);
    expect(drained.relationships[0]).toMatchObject({ declaredIn: 'p', fromPath: 'p/a', toPath: 'p/b', label: 'calls', evidenceIds: [e1.id, e2.id] });
    expect(drained.relationships[0]?.relationshipId).toBe(relationshipIdFor('p', 'p/a', 'p/b', 'calls'));
    expect(drained.items.every((i) => 'relationshipId' in i.subject)).toBe(true);
    expect(code(() => h.host.evidenceAdd({ ...base, refs: [{ file: 'src/server.ts' }], relationship: { ...relationship, toPath: '../x' } }))).toBe('invalid_element_path');
    expect(code(() => h.host.evidenceAdd({ ...base, refs: [{ file: 'src/server.ts' }], relationship: { ...relationship, label: '' } }))).toBe('invalid_relationship');
  });

  it('drain returns what was collected and clears it', () => {
    const h = makeHarness(MINI_APP);
    h.host.evidenceAdd({ ...base, refs: [{ file: 'src/server.ts' }] });
    expect(h.host.drain().items).toHaveLength(1);
    expect(h.host.drain()).toEqual({ items: [], relationships: [] });
    expect(h.host.stats().evidenceItems).toBe(1);
  });
});

describe('read accounting', () => {
  it('enforces the per-call budget without consuming the total', () => {
    const h = makeHarness(MINI_APP, { maxReadBytesPerCall: 100, maxReadBytesTotal: 1000 });
    const file = h.host.authorizeSnapshotPath('src/server.ts');
    expect(code(() => h.host.accountRead(file, 101))).toBe('budget:maxReadBytesPerCall');
    expect(h.host.stats().readBytes).toBe(0);
    expect(h.host.stats().limitsHit).toEqual([]);
    h.host.accountRead(file, 100);
    expect(h.host.stats()).toMatchObject({ readBytes: 100, readFiles: 1 });
  });

  it('enforces the cumulative budget and records it as a limit hit', () => {
    const h = makeHarness(MINI_APP, { maxReadBytesPerCall: 100, maxReadBytesTotal: 250 });
    const a = h.host.authorizeSnapshotPath('src/server.ts');
    const b = h.host.authorizeSnapshotPath('src/config.ts');
    h.host.accountRead(a, 100);
    h.host.accountRead(b, 100);
    expect(code(() => h.host.accountRead(a, 100))).toBe('budget:maxReadBytesTotal');
    expect(h.host.stats()).toMatchObject({ readBytes: 200, readFiles: 2, limitsHit: ['maxReadBytesTotal'] });
    expect(h.host.readPaths()).toEqual(['src/config.ts', 'src/server.ts']);
  });

  it('refuses to account a path outside the snapshot', () => {
    const h = makeHarness(MINI_APP);
    expect(code(() => h.host.accountRead('/etc/passwd', 10))).toBe('path_outside_snapshot');
    expect(code(() => h.host.accountRead(path.join(h.snapshotDir, 'x'), -1))).toBe('invalid_read');
  });

  it('delegates authorizeSnapshotPath to the path policy', () => {
    const h = makeHarness(MINI_APP);
    expect(code(() => h.host.authorizeSnapshotPath('../x'))).toBe('path_outside_snapshot');
    expect(h.host.authorizeSnapshotPath('src')).toBe(path.join(fs.realpathSync(h.snapshotDir), 'src'));
  });
});

describe('coverage, perspectives, stats', () => {
  it('keeps the last coverage statement and validates it', () => {
    const { host } = makeHarness(MINI_APP);
    expect(host.getCoverageStatement()).toBeNull();
    host.coverageReport({ covered: ['a'], excluded: [], notes: 'first' });
    host.coverageReport({ covered: ['b', 'c'], excluded: ['d'], notes: 'second' });
    expect(host.getCoverageStatement()).toEqual({ covered: ['b', 'c'], excluded: ['d'], notes: 'second' });
    expect(code(() => host.coverageReport({ covered: [''], excluded: [], notes: '' }))).toBe('invalid_coverage');
    expect(code(() => host.coverageReport({ covered: [], excluded: [], notes: 'x'.repeat(4097) }))).toBe('invalid_coverage');
    expect(code(() => host.coverageReport({ covered: 'src' as never, excluded: [], notes: '' }))).toBe('invalid_coverage');
    expect(host.getCoverageStatement()?.notes).toBe('second');
  });

  it('tracks perspective state and rejects bad names', () => {
    const { host } = makeHarness(MINI_APP);
    host.perspectiveStarted('overall-architecture');
    host.perspectiveStarted('data-flow');
    host.perspectiveDone('overall-architecture');
    expect(host.stats().perspectives).toEqual({ 'overall-architecture': 'done', 'data-flow': 'running' });
    expect(code(() => host.perspectiveStarted('../x'))).toBe('invalid_perspective');
  });

  it('stats reflects writes, reads and evidence', () => {
    const h = makeHarness(MINI_APP);
    h.host.ommWrite('p', 'description', 'x');
    h.host.ommWrite('p/a', 'description', 'x');
    h.host.accountRead(h.host.authorizeSnapshotPath('src/config.ts'), 10);
    h.host.evidenceAdd({ elementPath: 'p', claim: 'c', kind: 'observed', confidence: 'low', refs: [{ file: 'src/config.ts' }] });
    expect(h.host.stats()).toEqual({ readFiles: 1, readBytes: 10, elements: 2, evidenceItems: 1, perspectives: {}, limitsHit: [] });
  });
});
