/**
 * Path policy for the read-only built-in tools (SS00 §5.3, "Filesystem containment").
 *
 * Every path argument the model supplies to Read/Glob/Grep is resolved here. A path is
 * accepted only when its real location (symlinks resolved on the deepest existing
 * ancestor) is the snapshot directory or inside it. The check is done on the resolved
 * path so that `..`, absolute paths and symlinks pointing outside are all rejected by
 * one rule rather than by a list of tricks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ToolPolicyError } from './runtime.js';

export interface PathPolicy {
  /** Real, absolute path of the snapshot root. */
  readonly root: string;
  /**
   * Resolves `p` (relative paths are relative to the snapshot root) and returns the
   * absolute real path. Throws ToolPolicyError when the result is outside the snapshot.
   * Glob patterns are authorised by their non-glob prefix.
   */
  authorize(p: string): string;
  /** True when `abs` (already absolute and real) is the root or inside it. */
  contains(abs: string): boolean;
}

const GLOB_CHARS = /[*?[\]{}]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const MAX_PATH_LENGTH = 4096;

function describe(p: string): string {
  const shown = p.length > 120 ? `${p.slice(0, 120)}…` : p;
  return JSON.stringify(shown);
}

/** Longest leading run of segments that contain no glob metacharacters. */
function splitGlob(p: string): { prefix: string; tail: string[] } {
  const segments = p.split('/');
  const idx = segments.findIndex((s) => GLOB_CHARS.test(s));
  if (idx === -1) return { prefix: p, tail: [] };
  const head = segments.slice(0, idx).join('/');
  // An absolute pattern whose first segment is already a glob keeps its leading slash.
  const prefix = head === '' && p.startsWith('/') ? '/' : head;
  return { prefix, tail: segments.slice(idx) };
}

export function createPathPolicy(snapshotDir: string): PathPolicy {
  const root = fs.realpathSync(path.resolve(snapshotDir));

  const contains = (abs: string): boolean => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

  /** realpath of the deepest existing ancestor, re-joined with the not-yet-existing remainder. */
  function realpathDeepest(abs: string): string {
    let current = abs;
    const rest: string[] = [];
    for (;;) {
      try {
        const real = fs.realpathSync(current);
        return rest.length === 0 ? real : path.join(real, ...rest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          const parent = path.dirname(current);
          if (parent === current) throw new ToolPolicyError('path_unresolvable', `cannot resolve path ${describe(abs)}`);
          rest.unshift(path.basename(current));
          current = parent;
          continue;
        }
        // ELOOP, EACCES, ...: refuse rather than guess.
        throw new ToolPolicyError('path_unresolvable', `cannot resolve path ${describe(abs)} (${code ?? 'error'})`);
      }
    }
  }

  function authorize(p: string): string {
    if (typeof p !== 'string' || p.length === 0) throw new ToolPolicyError('path_invalid', 'path must be a non-empty string');
    if (p.length > MAX_PATH_LENGTH) throw new ToolPolicyError('path_invalid', 'path is too long');
    if (p.includes('\0')) throw new ToolPolicyError('path_invalid', 'path contains a NUL byte');
    if (p.startsWith('\\\\') || p.startsWith('//')) throw new ToolPolicyError('path_invalid', 'UNC paths are not allowed');
    if (WINDOWS_DRIVE.test(p)) throw new ToolPolicyError('path_invalid', 'Windows drive paths are not allowed');
    if (p.startsWith('~')) throw new ToolPolicyError('path_invalid', 'home-relative paths are not allowed');

    // Extglob groups such as "@(../x|y)" are expanded by the tool; names like "app/(auth)/page.ts"
    // are legitimate, so only the contents of the group are inspected.
    for (const m of p.matchAll(/\(([^()]*)\)/g)) {
      const alts = (m[1] ?? '').split(/[|,/]/);
      if (alts.some((a) => a === '..') || /^\s*[/~]/.test(m[1] ?? '')) {
        throw new ToolPolicyError('path_outside_snapshot', `path ${describe(p)} contains an unsafe group`);
      }
    }

    const { prefix, tail } = splitGlob(p);
    if (tail.length > 0) {
      // The glob tail is expanded by the tool, not by us, so it must not be able to climb
      // out or name another root. Reject `..` in any alternative and absolute / home
      // alternatives inside braces.
      const tailText = tail.join('/');
      if (tailText.split(/[/{},()|]/).some((s) => s === '..')) {
        throw new ToolPolicyError('path_outside_snapshot', `glob pattern ${describe(p)} contains ".."`);
      }
      if (/[{,|(]\s*[/~]/.test(tailText) || /[{,|(]\s*[a-zA-Z]:/.test(tailText)) {
        throw new ToolPolicyError('path_outside_snapshot', `glob pattern ${describe(p)} contains an absolute alternative`);
      }
    }

    const target = prefix === '' ? root : path.resolve(root, prefix);
    const real = realpathDeepest(target);
    if (!contains(real)) {
      throw new ToolPolicyError('path_outside_snapshot', `path ${describe(p)} resolves outside the repository snapshot`);
    }
    return real;
  }

  return { root, authorize, contains };
}
