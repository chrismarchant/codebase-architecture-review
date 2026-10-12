import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { componentIdFor, EvidenceItem } from '@archreview/contracts';
import { MockAgentRuntime, loadMockScript, parseMockScript, type MockStep } from '../../src/agent/index.js';
import { listNodes, listPerspectives, showNode, validateDiagram } from '../../src/upstream/index.js';
import { AGENT_FIXTURES, MINI_APP, cleanupTmp, makeHarness } from './helpers.js';

afterEach(cleanupTmp);

const script = (name: string) => loadMockScript(path.join(AGENT_FIXTURES, name));

function allElements(outDir: string): string[] {
  const out: string[] = [];
  const walk = (p: string[]) => {
    const kids = p.length === 0 ? listPerspectives(outDir) : listNodes(p[0] as string, p.slice(1), outDir);
    for (const k of kids) {
      out.push([...p, k].join('/'));
      walk([...p, k]);
    }
  };
  walk([]);
  return out.sort();
}

describe('MockAgentRuntime with sample-app.json', () => {
  async function runSample() {
    const h = makeHarness(MINI_APP);
    const rt = new MockAgentRuntime(script('sample-app.json'));
    const result = await rt.run(h.input, h.ctl);
    return { h, rt, result };
  }

  it('completes with deterministic usage', async () => {
    const a = await runSample();
    const b = await runSample();
    expect(a.result.status).toBe('completed');
    expect(a.result.turns).toBe(script('sample-app.json').steps.length);
    expect(a.result.usage).toEqual(b.result.usage);
    expect(a.result.usage).toMatchObject({ runtime: 'mock', estimatedBy: 'mock', totalCostUsd: 0 });
    expect(a.result.usage.byModel['claude-sonnet-5-5']?.inputTokens).toBe(a.result.turns * 100);
    expect(a.rt.id).toBe('mock');
    expect(a.rt.log.every((l) => l.ok)).toBe(true);
  });

  it('produces a tree accepted by upstream list/show and validate with zero errors', async () => {
    const { h } = await runSample();
    expect(listPerspectives(h.outDir)).toEqual(['overall-architecture', 'request-lifecycle']);
    expect(listNodes('overall-architecture', [], h.outDir)).toEqual(['configuration', 'database', 'http-api', 'order-service', 'payment-gateway']);
    expect(listNodes('overall-architecture', ['http-api'], h.outDir)).toEqual(['order-routes', 'server-bootstrap']);
    expect(listNodes('request-lifecycle', [], h.outDir)).toEqual(['charge-payment', 'persist-order', 'pricing', 'route-handler']);

    const shown = showNode('overall-architecture', ['order-service', 'pricing-rules'], h.outDir);
    expect(shown?.description).toContain('priceOrder');
    expect(shown?.meta?.kind).toBe('nested-class');
    expect(showNode('overall-architecture', [], h.outDir)?.meta?.kind).toBe('perspective');
    expect(showNode('overall-architecture', [], h.outDir)?.meta?.children).toContain('http-api');
    expect(fs.existsSync(path.join(h.outDir, '.omm', 'config.yaml'))).toBe(true);

    // Same checks `omm validate` performs, element by element, with sibling names as the ref context.
    const perspectives = listPerspectives(h.outDir);
    let diagrams = 0;
    for (const el of allElements(h.outDir)) {
      const [persp, ...rest] = el.split('/') as [string, ...string[]];
      const diagram = showNode(persp, rest, h.outDir)?.diagram;
      if (!diagram) continue;
      diagrams += 1;
      const result = validateDiagram(diagram, { className: el, allClasses: perspectives });
      expect(result.issues.filter((i) => i.level === 'error'), el).toEqual([]);
      expect(result.valid).toBe(true);
    }
    expect(diagrams).toBe(5);
  });

  it('writes a description for every element and diagram node ids match child directories', async () => {
    const { h } = await runSample();
    for (const el of allElements(h.outDir)) {
      const [persp, ...rest] = el.split('/') as [string, ...string[]];
      const node = showNode(persp, rest, h.outDir);
      expect(node?.description, el).toBeTruthy();
      if (node?.diagram) {
        // Node declarations only: upstream's lightweight parseMermaid invents nodes from edge labels with spaces.
        const ids = [...node.diagram.matchAll(/^\s*([a-z0-9-]+)\["/gm)].map((m) => m[1] as string);
        const children = listNodes(persp, rest, h.outDir);
        expect(ids.sort(), el).toEqual(children.sort());
      }
    }
  });

  it('records evidence for every element and every relationship, and a coverage statement', async () => {
    const { h } = await runSample();
    const elements = allElements(h.outDir);
    const drained = h.host.drain();
    const items = drained.items.map((i) => EvidenceItem.parse(i));
    const subjects = new Set(items.map((i) => ('componentId' in i.subject ? i.subject.componentId : '')));
    for (const el of elements) expect(subjects.has(componentIdFor(el)), `evidence for ${el}`).toBe(true);

    let edges = 0;
    for (const el of elements) {
      const [persp, ...rest] = el.split('/') as [string, ...string[]];
      const diagram = showNode(persp, rest, h.outDir)?.diagram;
      if (!diagram) continue;
      const labelled = diagram.split('\n').filter((l) => l.includes('-->|')).length;
      edges += labelled;
      const declared = drained.relationships.filter((r) => r.declaredIn === el);
      expect(declared.length, `relationship evidence declared in ${el}`).toBe(labelled);
      for (const r of declared) {
        expect(r.evidenceIds.length).toBeGreaterThan(0);
        expect(elements).toContain(r.fromPath);
        expect(elements).toContain(r.toPath);
        expect(diagram).toContain(`${r.fromPath.split('/').at(-1)}`);
        expect(diagram).toContain(`|"${r.label}"|`);
      }
    }
    expect(drained.relationships).toHaveLength(edges);
    expect(edges).toBeGreaterThanOrEqual(8);

    expect(h.host.getCoverageStatement()?.covered).toHaveLength(h.inventory.files.length);
    expect(h.host.readPaths()).toEqual(h.inventory.files.map((f) => f.path).sort());
    const stats = h.host.stats();
    expect(stats.perspectives).toEqual({ 'overall-architecture': 'done', 'request-lifecycle': 'done' });
    expect(stats.elements).toBe(elements.length);
    expect(stats.limitsHit).toEqual([]);
  });

  it('emits progress for turns, tools and perspectives', async () => {
    const { h } = await runSample();
    expect(h.events.filter((e) => e.type === 'turn')).toHaveLength(script('sample-app.json').steps.length);
    expect(h.events).toContainEqual({ type: 'perspective', name: 'overall-architecture', state: 'running' });
    expect(h.events).toContainEqual({ type: 'perspective', name: 'request-lifecycle', state: 'done' });
    expect(h.events.some((e) => e.type === 'tool' && e.name === 'omm_write' && e.ok)).toBe(true);
  });
});

describe('MockAgentRuntime control flow', () => {
  it('cancel-midway.json stops early with aborted', async () => {
    const h = makeHarness(MINI_APP);
    h.ctl.onProgress = (e) => {
      h.events.push(e);
      if (e.type === 'note' && e.message === 'cancel-here') h.controller.abort();
    };
    const result = await new MockAgentRuntime(script('cancel-midway.json')).run(h.input, h.ctl);
    expect(result.status).toBe('aborted');
    expect(result.turns).toBeLessThan(script('cancel-midway.json').steps.length);
    expect(listPerspectives(h.outDir)).toEqual(['overall-architecture']);
    expect(listNodes('overall-architecture', [], h.outDir)).toEqual([]);
    expect(h.events.some((e) => e.type === 'perspective' && e.state === 'done')).toBe(false);
  });

  it('does not start when the signal is already aborted', async () => {
    const h = makeHarness(MINI_APP);
    h.controller.abort();
    const result = await new MockAgentRuntime(script('sample-app.json')).run(h.input, h.ctl);
    expect(result).toMatchObject({ status: 'aborted', turns: 0 });
    expect(listPerspectives(h.outDir)).toEqual([]);
  });

  it('budget-exhaust.json ends as budget_exhausted when reads exceed the total budget', async () => {
    const h = makeHarness(MINI_APP, { maxReadBytesTotal: 2000, maxReadBytesPerCall: 2000 });
    const result = await new MockAgentRuntime(script('budget-exhaust.json')).run(h.input, h.ctl);
    expect(result.status).toBe('budget_exhausted');
    expect(result.error?.code).toBe('budget_maxReadBytesTotal');
    expect(h.events.some((e) => e.type === 'budget' && e.budget === 'maxReadBytesTotal')).toBe(true);
    expect(h.host.stats().limitsHit).toContain('maxReadBytesTotal');
    expect(listPerspectives(h.outDir)).toEqual([]);
  });

  it('ends as budget_exhausted when the element cap is hit, keeping what was written', async () => {
    const h = makeHarness(MINI_APP, { maxElements: 5 });
    const result = await new MockAgentRuntime(script('sample-app.json')).run(h.input, h.ctl);
    expect(result.status).toBe('budget_exhausted');
    expect(result.error?.code).toBe('budget_maxElements');
    expect(h.host.stats().elements).toBe(5);
  });

  it('continues after a per-call refusal or a policy error (the model would see a tool error)', async () => {
    const h = makeHarness(MINI_APP, { maxReadBytesPerCall: 300 });
    const steps: MockStep[] = [
      { read: 'src/routes/orders.ts' },
      { tool: 'omm_write', args: { path: 'Bad Path', field: 'description', content: 'x' } },
      { read: 'src/db/queries.ts' },
      { tool: 'omm_write', args: { path: 'ok', field: 'description', content: 'x' } },
    ];
    const rt = new MockAgentRuntime(steps);
    const result = await rt.run(h.input, h.ctl);
    expect(result.status).toBe('completed');
    expect(rt.log.map((l) => l.ok)).toEqual([false, false, true, true]);
    expect(rt.log[0]?.error?.code).toBe('budget_maxReadBytesPerCall');
    expect(rt.log[1]?.error?.code).toBe('invalid_element_path');
  });

  it('parses bare arrays and rejects malformed scripts', () => {
    expect(parseMockScript([{ note: 'x' }]).steps).toHaveLength(1);
    expect(() => parseMockScript({ steps: [{ tool: 'bash', args: { command: 'ls' } }] })).toThrow();
    expect(() => parseMockScript({ steps: [{ tool: 'omm_write', args: { path: 1 } }] })).toThrow();
  });

  it('every fixture script parses', () => {
    for (const f of fs.readdirSync(AGENT_FIXTURES).filter((n) => n.endsWith('.json'))) {
      expect(script(f).steps.length, f).toBeGreaterThan(0);
    }
  });
});
