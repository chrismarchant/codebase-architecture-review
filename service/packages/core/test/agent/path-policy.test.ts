import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolPolicyError, createPathPolicy } from '../../src/agent/index.js';
import { cleanupTmp, makeTmp } from './helpers.js';

afterEach(cleanupTmp);

function setup() {
  const base = makeTmp('pp-');
  const snap = path.join(base, 'snapshot');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(snap, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(snap, 'src', 'a.ts'), 'a');
  fs.writeFileSync(path.join(snap, 'src', 'deep', 'b.ts'), 'b');
  fs.writeFileSync(path.join(snap, 'app (1).ts'), 'c');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  return { base, snap, outside, policy: createPathPolicy(snap) };
}

const rejects = (fn: () => unknown, code?: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolPolicyError);
    if (code) expect((e as ToolPolicyError).code).toBe(code);
    return;
  }
  throw new Error('expected ToolPolicyError');
};

describe('createPathPolicy', () => {
  it('accepts the root, relative and nested paths and returns real absolute paths', () => {
    const { snap, policy } = setup();
    expect(policy.authorize('.')).toBe(policy.root);
    expect(policy.authorize('src/a.ts')).toBe(path.join(policy.root, 'src', 'a.ts'));
    expect(policy.authorize('src/deep/b.ts')).toBe(path.join(policy.root, 'src', 'deep', 'b.ts'));
    expect(policy.authorize(path.join(snap, 'src', 'a.ts'))).toBe(path.join(policy.root, 'src', 'a.ts'));
    expect(policy.authorize('src/./deep/../a.ts')).toBe(path.join(policy.root, 'src', 'a.ts'));
  });

  it('accepts paths that do not exist yet when the deepest ancestor is inside', () => {
    const { policy } = setup();
    expect(policy.authorize('src/missing/file.ts')).toBe(path.join(policy.root, 'src', 'missing', 'file.ts'));
  });

  it('accepts file names containing parentheses and spaces', () => {
    const { policy } = setup();
    expect(policy.authorize('app (1).ts')).toBe(path.join(policy.root, 'app (1).ts'));
  });

  it('rejects parent traversal', () => {
    const { policy } = setup();
    rejects(() => policy.authorize('../outside/secret.txt'), 'path_outside_snapshot');
    rejects(() => policy.authorize('src/../../outside/secret.txt'), 'path_outside_snapshot');
    rejects(() => policy.authorize('..'), 'path_outside_snapshot');
  });

  it('rejects absolute paths outside the snapshot, including a sibling with the same prefix', () => {
    const { base, snap, outside, policy } = setup();
    rejects(() => policy.authorize('/etc/passwd'), 'path_outside_snapshot');
    rejects(() => policy.authorize(path.join(outside, 'secret.txt')), 'path_outside_snapshot');
    fs.mkdirSync(`${snap}-evil`);
    rejects(() => policy.authorize(`${snap}-evil`), 'path_outside_snapshot');
    expect(base).toBeTruthy();
  });

  it('rejects a symlink inside the snapshot that points outside (file and directory)', () => {
    const { snap, outside, policy } = setup();
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(snap, 'link-file'));
    fs.symlinkSync(outside, path.join(snap, 'link-dir'));
    rejects(() => policy.authorize('link-file'), 'path_outside_snapshot');
    rejects(() => policy.authorize('link-dir'), 'path_outside_snapshot');
    rejects(() => policy.authorize('link-dir/secret.txt'), 'path_outside_snapshot');
    rejects(() => policy.authorize('link-dir/not-yet/created.txt'), 'path_outside_snapshot');
  });

  it('allows a symlink that stays inside the snapshot', () => {
    const { snap, policy } = setup();
    fs.symlinkSync(path.join(snap, 'src'), path.join(snap, 'alias'));
    expect(policy.authorize('alias/a.ts')).toBe(path.join(policy.root, 'src', 'a.ts'));
  });

  it('rejects NUL bytes, UNC paths, Windows drive prefixes and home-relative paths', () => {
    const { policy } = setup();
    rejects(() => policy.authorize('src/a.ts\0.png'), 'path_invalid');
    rejects(() => policy.authorize('\\\\server\\share\\x'), 'path_invalid');
    rejects(() => policy.authorize('//server/share/x'), 'path_invalid');
    rejects(() => policy.authorize('C:\\Windows\\System32'), 'path_invalid');
    rejects(() => policy.authorize('c:/Windows'), 'path_invalid');
    rejects(() => policy.authorize('~/.aws/credentials'), 'path_invalid');
    rejects(() => policy.authorize(''), 'path_invalid');
  });

  it('authorises glob patterns by their non-glob prefix', () => {
    const { policy } = setup();
    expect(policy.authorize('src/**/*.ts')).toBe(path.join(policy.root, 'src'));
    expect(policy.authorize('**/*.ts')).toBe(policy.root);
    expect(policy.authorize(path.join(policy.root, 'src', '*.ts'))).toBe(path.join(policy.root, 'src'));
    rejects(() => policy.authorize('../**/*.ts'), 'path_outside_snapshot');
    rejects(() => policy.authorize('/etc/*'), 'path_outside_snapshot');
  });

  it('rejects glob tails that climb out or name another root', () => {
    const { policy } = setup();
    rejects(() => policy.authorize('src/*/../../..'), 'path_outside_snapshot');
    rejects(() => policy.authorize('{src,../outside}/*'), 'path_outside_snapshot');
    rejects(() => policy.authorize('{src,/etc}/*'), 'path_outside_snapshot');
    rejects(() => policy.authorize('src/@(../x|y)'), 'path_outside_snapshot');
  });

  it('is not fooled by a symlink loop', () => {
    const { snap, policy } = setup();
    fs.symlinkSync(path.join(snap, 'loop-b'), path.join(snap, 'loop-a'));
    fs.symlinkSync(path.join(snap, 'loop-a'), path.join(snap, 'loop-b'));
    rejects(() => policy.authorize('loop-a'), 'path_unresolvable');
  });
});
