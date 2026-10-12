/** Local test helpers for the agent/omm tests (the shared `testing` module is owned by another task). */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGETS, SCHEMA_IDS, type AnalysisBudgets, type Inventory } from '@archreview/contracts';
import { ArchreviewToolHost, type AgentRunControl, type AgentRunInput, type AgentProgressEvent } from '../../src/agent/index.js';

export const SERVICE_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
export const FIXTURES = path.join(SERVICE_DIR, 'fixtures');
export const MINI_APP = path.join(FIXTURES, 'repos', 'mini-app');
export const HOSTILE = path.join(FIXTURES, 'repos', 'hostile-instructions');
export const AGENT_FIXTURES = path.join(FIXTURES, 'agent');

const tmpDirs: string[] = [];
export function makeTmp(prefix = 'archreview-test-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
export function cleanupTmp(): void {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

const LANG: Record<string, string> = { '.ts': 'typescript', '.json': 'json', '.md': 'markdown' };

/** Builds an archreview.inventory/1.0 for a plain directory. `lines` = number of text lines. */
export function buildInventory(dir: string): Inventory {
  const files = walk(dir).map((p) => {
    const buf = fs.readFileSync(path.join(dir, p));
    const text = buf.toString('utf-8');
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { path: p, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), language: LANG[path.extname(p)] ?? null, lines };
  });
  const byLanguage: Record<string, number> = {};
  for (const f of files) if (f.language) byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;
  return {
    schema: SCHEMA_IDS.inventory,
    commitSha: 'a'.repeat(40),
    snapshotSha256: 'b'.repeat(64),
    files,
    excluded: [],
    totals: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), byLanguage },
    generatedAt: '2026-10-12T00:00:00.000Z',
  };
}

export interface Harness {
  workspaceRoot: string;
  snapshotDir: string;
  outDir: string;
  inventory: Inventory;
  host: ArchreviewToolHost;
  budgets: AnalysisBudgets;
  events: AgentProgressEvent[];
  controller: AbortController;
  input: AgentRunInput;
  ctl: AgentRunControl;
}

/** Workspace with snapshot/ (a copy of `repoDir`) and out/, plus a tool host and run input. */
export function makeHarness(repoDir: string, budgets: Partial<AnalysisBudgets> = {}): Harness {
  const workspaceRoot = makeTmp('archreview-ws-');
  const snapshotDir = path.join(workspaceRoot, 'snapshot');
  const outDir = path.join(workspaceRoot, 'out');
  fs.cpSync(repoDir, snapshotDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const inventory = buildInventory(snapshotDir);
  const b: AnalysisBudgets = { ...DEFAULT_BUDGETS, ...budgets };
  const host = new ArchreviewToolHost({ snapshotDir, outDir, inventory, budgets: b, language: 'en' });
  const events: AgentProgressEvent[] = [];
  const controller = new AbortController();
  const input: AgentRunInput = {
    workspaceRoot,
    snapshotDir,
    inventory,
    perspectivesCompleted: [],
    language: 'en',
    budgets: b,
    model: { id: 'claude-sonnet-5-5' },
    promptBundle: { systemPrompt: 'SYSTEM', taskPrompt: 'TASK', sha256: 'c'.repeat(64) },
  };
  const ctl: AgentRunControl = { signal: controller.signal, onProgress: (e) => events.push(e), tools: host };
  return { workspaceRoot, snapshotDir, outDir, inventory, host, budgets: b, events, controller, input, ctl };
}
