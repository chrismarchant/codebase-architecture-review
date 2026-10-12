/**
 * Upstream CLI parity (docs/UPSTREAM-PARITY.md §5): the built `omm` CLI from the
 * repository root still behaves as documented, exercised on a temporary project.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.js');

function omm(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: 'utf-8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('upstream omm CLI', () => {
  let cwd: string;
  beforeAll(() => {
    if (!fs.existsSync(cli)) throw new Error(`upstream not built: ${cli} (run npm run build at the repo root)`);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-parity-'));
  });

  it('prints help listing every documented command', () => {
    const { code, out } = omm(cwd, ['help']);
    expect(code).toBe(0);
    for (const c of ['init', 'setup', 'update', 'list', 'tree', 'read', 'write', 'show', 'delete', 'status', 'diff', 'refs', 'validate', 'view', 'login', 'logout', 'link', 'push', 'pull', 'share', 'org']) {
      expect(out).toContain(`omm ${c}`);
    }
  });

  it('reports the upstream version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version: string };
    expect(omm(cwd, ['--version']).out.trim()).toBe(`omm ${pkg.version}`);
  });

  it('writes and reads nested fields, lists a tree, validates and diffs', () => {
    const diagram = 'graph LR\n    api["API\\nsrc/api/"] -->|"calls"| db["DB\\nsrc/db/"]\n';
    expect(omm(cwd, ['write', 'overall-architecture', 'diagram', '-'], diagram).code).toBe(0);
    expect(omm(cwd, ['write', 'overall-architecture', 'description', 'Top level']).code).toBe(0);
    expect(omm(cwd, ['write', 'overall-architecture/api', 'description', 'API element']).code).toBe(0);
    expect(omm(cwd, ['read', 'overall-architecture/api', 'description']).out).toBe('API element');
    expect(omm(cwd, ['list']).out).toContain('overall-architecture');
    const tree = omm(cwd, ['tree', 'overall-architecture']).out;
    expect(tree).toContain('overall-architecture');
    expect(tree).toContain('api');
    expect(omm(cwd, ['validate', 'overall-architecture']).code).toBe(0);
    const diagram2 = diagram + '    api -->|"emits"| queue["Queue\\nsrc/queue/"]\n';
    expect(omm(cwd, ['write', 'overall-architecture', 'diagram', '-'], diagram2).code).toBe(0);
    const diff = omm(cwd, ['diff', 'overall-architecture']).out;
    // Upstream's lightweight parser reports the added edge; with the `-->|"label"|` form it
    // records the label token rather than the target id (observed upstream behaviour,
    // recorded in docs/UPSTREAM-PARITY.md §3). We assert only that a change is reported.
    expect(diff).toContain('Added edges:');
    const meta = fs.readFileSync(path.join(cwd, '.omm', 'overall-architecture', 'meta.yaml'), 'utf-8');
    expect(meta).toContain('prev_diagram');
    expect(meta).toContain('children:');
  });

  it('keeps the legacy <path> <field> alias', () => {
    expect(omm(cwd, ['overall-architecture', 'description']).out).toBe('Top level');
  });
});
