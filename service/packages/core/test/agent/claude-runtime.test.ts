import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkRuntime, type AgentProgressEvent } from '../../src/agent/index.js';
import { MINI_APP, callOptions, cleanupTmp, makeHarness, makeTmp } from './helpers.js';

afterEach(cleanupTmp);

const assistant = (id: string, parent: string | null = null) =>
  ({ type: 'assistant', message: { id, content: [] }, parent_tool_use_id: parent, uuid: id, session_id: 's' }) as unknown as SDKMessage;

function result(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    duration_ms: 1234,
    duration_api_ms: 900,
    num_turns: 7,
    total_cost_usd: 0.42,
    usage: {},
    modelUsage: {
      'claude-sonnet-5-5': {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 25,
        webSearchRequests: 0,
        costUSD: 0.4,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
    errors: subtype === 'error_during_execution' ? ['boom'] : [],
    ...extra,
  } as unknown as SDKMessage;
}

type Capture = { prompt?: string; options?: Options };
function runtimeWith(messages: SDKMessage[] | ((cap: Capture) => AsyncIterable<SDKMessage>), cap: Capture = {}) {
  const tmpRoot = makeTmp('rt-tmp-');
  const rt = new ClaudeAgentSdkRuntime({
    apiKey: 'sk-test',
    tmpRoot,
    queryImpl: (params) => {
      cap.prompt = params.prompt;
      cap.options = params.options;
      if (typeof messages === 'function') return messages(cap);
      return (async function* () {
        for (const m of messages) yield m;
      })();
    },
  });
  return { rt, tmpRoot, cap };
}

describe('ClaudeAgentSdkRuntime', () => {
  it('has id claude-agent-sdk and requires an API key', () => {
    expect(runtimeWith([]).rt.id).toBe('claude-agent-sdk');
    expect(() => new ClaudeAgentSdkRuntime({ apiKey: '' })).toThrow();
  });

  it('passes the task prompt and options to query and maps a success result', async () => {
    const h = makeHarness(MINI_APP);
    const cap: Capture = {};
    const { rt } = runtimeWith([assistant('m1'), assistant('m1'), assistant('m2'), assistant('sub', 'tool-1'), result('success')], cap);
    const r = await rt.run(h.input, h.ctl);
    expect(cap.prompt).toBe('TASK');
    expect(cap.options?.systemPrompt).toBe('SYSTEM');
    expect(r.status).toBe('completed');
    expect(r.turns).toBe(7);
    expect(r.usage).toEqual({
      runtime: 'claude-agent-sdk',
      estimatedBy: 'claude-agent-sdk',
      totalCostUsd: 0.42,
      durationMs: 1234,
      apiDurationMs: 900,
      byModel: { 'claude-sonnet-5-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 25, costUsd: 0.4 } },
    });
    // Duplicate assistant message ids and sub-agent messages do not add turns.
    expect(h.events.filter((e) => e.type === 'turn')).toEqual([{ type: 'turn', turn: 1 }, { type: 'turn', turn: 2 }]);
  });

  it('maps budget subtypes to budget_exhausted and other failures to error', async () => {
    for (const subtype of ['error_max_turns', 'error_max_budget_usd']) {
      const h = makeHarness(MINI_APP);
      const r = await runtimeWith([result(subtype)]).rt.run(h.input, h.ctl);
      expect(r.status, subtype).toBe('budget_exhausted');
      expect(r.error?.code).toBe(subtype);
    }
    const h = makeHarness(MINI_APP);
    const r = await runtimeWith([result('error_during_execution')]).rt.run(h.input, h.ctl);
    expect(r).toMatchObject({ status: 'error', error: { code: 'error_during_execution', message: 'boom' } });
    const h2 = makeHarness(MINI_APP);
    const r2 = await runtimeWith([result('success', { is_error: true })]).rt.run(h2.input, h2.ctl);
    expect(r2).toMatchObject({ status: 'error', error: { code: 'api_error' } });
  });

  it('reports error when the stream ends without a result or throws', async () => {
    const h = makeHarness(MINI_APP);
    expect((await runtimeWith([assistant('m1')]).rt.run(h.input, h.ctl)).error?.code).toBe('no_result');
    const h2 = makeHarness(MINI_APP);
    const { rt } = runtimeWith(() => (async function* () { throw new Error('connection reset'); yield assistant('x'); })());
    const r = await rt.run(h2.input, h2.ctl);
    expect(r.status).toBe('error');
    expect(r.error).toEqual({ code: 'sdk_error', message: 'Error: connection reset' });
  });

  it('bridges ctl.signal to the SDK abort controller and reports aborted', async () => {
    const h = makeHarness(MINI_APP);
    const cap: Capture = {};
    const { rt } = runtimeWith((c) =>
      (async function* () {
        yield assistant('m1');
        h.controller.abort();
        expect(c.options?.abortController?.signal.aborted).toBe(true);
        throw new Error('The operation was aborted');
      })(),
      cap,
    );
    const r = await rt.run(h.input, h.ctl);
    expect(r.status).toBe('aborted');
    expect(r.turns).toBe(1);
    expect(r.usage.byModel).toEqual({});
  });

  it('aborts immediately when the signal is already aborted', async () => {
    const h = makeHarness(MINI_APP);
    h.controller.abort();
    const cap: Capture = {};
    const { rt } = runtimeWith(() => (async function* () { throw new Error('aborted'); yield assistant('x'); })(), cap);
    const r = await rt.run(h.input, h.ctl);
    expect(r.status).toBe('aborted');
    expect(cap.options?.abortController?.signal.aborted).toBe(true);
  });

  it('turns a host budget hit (total read bytes) into budget_exhausted and emits a budget event', async () => {
    const h = makeHarness(MINI_APP, { maxReadBytesTotal: 10 });
    const { rt } = runtimeWith((c) =>
      (async function* () {
        const can = c.options!.canUseTool!;
        const r = await can('Read', { file_path: 'src/server.ts' }, callOptions() as never);
        expect(r.behavior).toBe('deny');
        yield assistant('m1');
        yield result('success');
      })(),
    );
    const r = await rt.run(h.input, h.ctl);
    expect(r.status).toBe('budget_exhausted');
    expect(r.error?.code).toBe('budget_maxReadBytesTotal');
    expect(h.events.some((e) => e.type === 'budget' && e.budget === 'maxReadBytesTotal')).toBe(true);
    expect(h.events).toContainEqual({ type: 'tool', name: 'Read', ok: false, detail: 'budget:maxReadBytesTotal' });
  });

  it('emits tool and perspective progress from built-in decisions and MCP calls', async () => {
    const h = makeHarness(MINI_APP);
    const { rt } = runtimeWith((c) =>
      (async function* () {
        const can = c.options!.canUseTool!;
        const o = callOptions() as never;
        await can('Read', { file_path: 'src/server.ts' }, o);
        await can('Bash', { command: 'id' }, o);
        await can('mcp__archreview__omm_write', {}, o);
        // Call the MCP server through the options the runtime built.
        const server = c.options!.mcpServers!.archreview as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } };
        const tools = server.instance._registeredTools;
        await tools.perspective_started!.handler({ name: 'overall-architecture' }, {});
        await tools.omm_write!.handler({ path: 'overall-architecture', field: 'description', content: 'x' }, {});
        yield assistant('m1');
        yield result('success');
      })(),
    );
    await rt.run(h.input, h.ctl);
    const ev: AgentProgressEvent[] = h.events;
    expect(ev).toContainEqual({ type: 'tool', name: 'Read', ok: true });
    expect(ev).toContainEqual({ type: 'tool', name: 'Bash', ok: false, detail: 'tool_not_allowed' });
    expect(ev).toContainEqual({ type: 'tool', name: 'omm_write', ok: true });
    expect(ev).toContainEqual({ type: 'perspective', name: 'overall-architecture', state: 'running' });
    expect(h.host.stats().elements).toBe(1);
  });

  it('creates a throwaway HOME for the run and removes it afterwards', async () => {
    const h = makeHarness(MINI_APP);
    const cap: Capture = {};
    const { rt, tmpRoot } = runtimeWith([result('success')], cap);
    await rt.run(h.input, h.ctl);
    const home = cap.options?.env?.HOME as string;
    expect(path.dirname(home)).toBe(tmpRoot);
    expect(path.basename(home)).toMatch(/^archreview-agent-home-/);
    expect(fs.existsSync(home)).toBe(false);
    expect(home.startsWith(os.homedir())).toBe(false);
  });

  it('survives a throwing progress consumer', async () => {
    const h = makeHarness(MINI_APP);
    h.ctl.onProgress = () => {
      throw new Error('consumer bug');
    };
    const r = await runtimeWith([assistant('m1'), result('success')]).rt.run(h.input, h.ctl);
    expect(r.status).toBe('completed');
  });
});
