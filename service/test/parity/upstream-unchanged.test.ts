/**
 * Upstream files outside the allow-list in docs/UPSTREAM-PARITY.md §6 must be
 * byte-identical to the `upstream-baseline` tag.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOWED_CHANGES = new Set(['src/server/viewer.html', 'src/index.ts', '.gitignore', 'README.md', 'README.ja.md', 'README.ko.md', 'README.tr.md', 'README.zh.md']);

describe('upstream tree parity', () => {
  it('only allow-listed upstream files differ from upstream-baseline', () => {
    const r = spawnSync('git', ['diff', '--name-only', 'upstream-baseline', '--', '.', ':!service', ':!docs', ':!.railway', ':!.github/workflows/service-ci.yml', ':!.dockerignore'], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(r.status, r.stderr).toBe(0);
    const changed = r.stdout.split('\n').filter(Boolean);
    const unexpected = changed.filter((f) => !ALLOWED_CHANGES.has(f));
    expect(unexpected, `unexpected upstream changes: ${unexpected.join(', ')}`).toEqual([]);
  });

  it('upstream-baseline tag points at the recorded commit', () => {
    const r = spawnSync('git', ['rev-parse', 'upstream-baseline^{commit}'], { cwd: root, encoding: 'utf-8' });
    expect(r.stdout.trim()).toBe('38ccdb69298adec949177c92c88d6e3ddfb5bab7');
  });
});
