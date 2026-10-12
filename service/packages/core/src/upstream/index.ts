/**
 * Single point of contact with the upstream oh-my-mermaid build output (ADR-002).
 *
 * The service never copies upstream source. It re-exports the public API that
 * upstream ships in `dist/index.js` (built from `src/index.ts` at the repository
 * root) and resolves upstream's non-code assets (viewer.html, skills) from the
 * repository root at runtime.
 *
 * Layout assumption (identical for src/ and dist/ because both sit at depth 5):
 *   <repo>/service/packages/core/{src|dist}/upstream/index.{ts|js}
 *   <repo>/dist/index.js
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export * from '../../../../../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the upstream repository root (override with ARCHREVIEW_UPSTREAM_ROOT). */
export function upstreamRoot(): string {
  const override = process.env.ARCHREVIEW_UPSTREAM_ROOT;
  if (override) return path.resolve(override);
  return path.resolve(here, '..', '..', '..', '..', '..');
}

export function upstreamViewerHtmlPath(): string {
  const root = upstreamRoot();
  const candidates = [path.join(root, 'dist', 'viewer.html'), path.join(root, 'src', 'server', 'viewer.html')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`upstream viewer.html not found under ${root} (run the root build first)`);
}

export function upstreamSkillPath(skill: 'omm-scan' | 'omm-push' | 'omm-view'): string {
  const p = path.join(upstreamRoot(), 'skills', skill, 'SKILL.md');
  if (!fs.existsSync(p)) throw new Error(`upstream skill not found: ${p}`);
  return p;
}

export function upstreamVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(upstreamRoot(), 'package.json'), 'utf-8')) as { version: string };
  return pkg.version;
}
