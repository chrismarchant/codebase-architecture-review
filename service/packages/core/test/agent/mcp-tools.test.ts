import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOL_NAMES, createArchreviewMcpServer, isArchreviewMcpTool, mcpToolName, type McpToolHooks } from '../../src/agent/index.js';
import { MINI_APP, cleanupTmp, makeHarness } from './helpers.js';

afterEach(cleanupTmp);

async function connect(budgets = {}) {
  const h = makeHarness(MINI_APP, budgets);
  const calls: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const perspectives: string[] = [];
  const budgetHits: string[] = [];
  const hooks: McpToolHooks = {
    onTool: (e) => calls.push(e),
    onPerspective: (n, s) => perspectives.push(`${n}:${s}`),
    onBudget: (e) => budgetHits.push(e.budget),
  };
  const server = createArchreviewMcpServer(h.host, hooks);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.instance.connect(serverT), client.connect(clientT)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { text: r.content[0]?.text ?? '', isError: r.isError === true };
  };
  return { h, client, call, calls, perspectives, budgetHits };
}

describe('archreview MCP server', () => {
  it('exposes exactly the seven tools', async () => {
    const { client } = await connect();
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual([...MCP_TOOL_NAMES].sort());
    expect(MCP_TOOL_NAMES.map(mcpToolName).every(isArchreviewMcpTool)).toBe(true);
    expect(isArchreviewMcpTool('mcp__archreview__bash')).toBe(false);
    expect(isArchreviewMcpTool('omm_write')).toBe(false);
  });

  it('omm_write / omm_read / omm_list delegate to the host', async () => {
    const { h, call } = await connect();
    expect(await call('omm_write', { path: 'overall-architecture', field: 'description', content: 'hi' })).toEqual({
      text: 'wrote overall-architecture/description (2 bytes)',
      isError: false,
    });
    expect((await call('omm_read', { path: 'overall-architecture', field: 'description' })).text).toBe('hi');
    expect((await call('omm_read', { path: 'overall-architecture', field: 'note' })).text).toBe('(not written)');
    expect((await call('omm_list', {})).text).toBe('overall-architecture');
    expect((await call('omm_list', { path: 'overall-architecture' })).text).toBe('(none)');
    expect(h.host.stats().elements).toBe(1);
  });

  it('converts ToolPolicyError into an isError result with the message', async () => {
    const { call, calls } = await connect();
    const r = await call('omm_write', { path: '../../etc/passwd', field: 'description', content: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^invalid_element_path:/);
    expect(calls.at(-1)).toEqual({ name: 'omm_write', ok: false, detail: 'invalid_element_path' });
  });

  it('rejects arguments that fail the zod schema (unknown field)', async () => {
    const { call } = await connect();
    const r = await call('omm_write', { path: 'a', field: 'exec', content: 'x' });
    expect(r.isError).toBe(true);
  });

  it('converts BudgetExceeded into an isError result and notifies the hook', async () => {
    const { call, budgetHits } = await connect({ maxElements: 1 });
    expect((await call('omm_write', { path: 'a', field: 'description', content: 'x' })).isError).toBe(false);
    const r = await call('omm_write', { path: 'b', field: 'description', content: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/budget_exceeded \(maxElements\)/);
    expect(budgetHits).toEqual(['maxElements']);
  });

  it('evidence_add defaults confidence and validates against the inventory', async () => {
    const { h, call } = await connect();
    const ok = await call('evidence_add', {
      elementPath: 'overall-architecture',
      claim: 'entry point',
      kind: 'observed',
      refs: [{ file: 'src/server.ts', startLine: 1, endLine: 5 }],
    });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/^recorded evidence e_[0-9a-f]{12}$/);
    expect(h.host.drain().items[0]?.confidence).toBe('medium');
    const bad = await call('evidence_add', { elementPath: 'a', claim: 'x', kind: 'observed', refs: [{ file: '/etc/passwd' }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/invalid_ref/);
    const rel = await call('evidence_add', {
      elementPath: 'p',
      claim: 'edge',
      kind: 'interpretation',
      confidence: 'low',
      refs: [{ file: 'src/config.ts' }],
      relationship: { fromPath: 'p/a', toPath: 'p/b', label: 'uses' },
    });
    expect(rel.isError).toBe(false);
    expect(h.host.drain().relationships).toHaveLength(1);
  });

  it('coverage_report and perspective tools record state and notify', async () => {
    const { h, call, perspectives } = await connect();
    expect((await call('perspective_started', { name: 'overall-architecture' })).isError).toBe(false);
    expect((await call('perspective_done', { name: 'overall-architecture' })).isError).toBe(false);
    expect((await call('perspective_started', { name: 'Bad Name' })).isError).toBe(true);
    expect((await call('coverage_report', { covered: ['src/'], excluded: [], notes: 'ok' })).isError).toBe(false);
    expect(perspectives).toEqual(['overall-architecture:running', 'overall-architecture:done']);
    expect(h.host.getCoverageStatement()?.covered).toEqual(['src/']);
    expect(h.host.stats().perspectives).toEqual({ 'overall-architecture': 'done' });
  });
});
