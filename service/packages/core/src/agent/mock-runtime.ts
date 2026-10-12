/**
 * Scripted agent runtime for tests and offline runs (SS00 §4.3).
 *
 * It replays a fixed list of tool calls against the same tool host the real runtime uses, so
 * policy, budgets and evidence handling are exercised identically. Policy errors do not stop a
 * script (the model would see them as tool errors and carry on); budget exhaustion and
 * cancellation do. Usage is a pure function of the script, hence deterministic.
 */
import fs from 'node:fs';
import { z } from 'zod';
import type { OmmField } from '@archreview/contracts';
import {
  BudgetExceeded,
  ToolPolicyError,
  type AgentRunControl,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
} from './runtime.js';

const Ref = z.object({
  file: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  symbol: z.string().optional(),
});

const ToolStep = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('omm_write'), args: z.object({ path: z.string(), field: z.string(), content: z.string() }) }),
  z.object({ tool: z.literal('omm_read'), args: z.object({ path: z.string(), field: z.string() }) }),
  z.object({ tool: z.literal('omm_list'), args: z.object({ path: z.string().optional() }).default({}) }),
  z.object({
    tool: z.literal('evidence_add'),
    args: z.object({
      elementPath: z.string(),
      claim: z.string(),
      kind: z.string(),
      refs: z.array(Ref),
      confidence: z.string().optional(),
      relationship: z.object({ fromPath: z.string(), toPath: z.string(), label: z.string() }).optional(),
    }),
  }),
  z.object({
    tool: z.literal('coverage_report'),
    args: z.object({ covered: z.array(z.string()), excluded: z.array(z.string()), notes: z.string() }),
  }),
  z.object({ tool: z.literal('perspective_started'), args: z.object({ name: z.string() }) }),
  z.object({ tool: z.literal('perspective_done'), args: z.object({ name: z.string() }) }),
]);

export const MockStep = z.union([
  ToolStep,
  /** A Read of a snapshot file: authorise, then account the real file size. */
  z.object({ read: z.string() }),
  /** Emits a `note` progress event; lets a test (or fixture) mark a point to cancel at. */
  z.object({ note: z.string() }),
]);
export type MockStep = z.infer<typeof MockStep>;

export const MockScript = z.object({
  description: z.string().optional(),
  steps: z.array(MockStep),
});
export type MockScript = z.infer<typeof MockScript>;

/** Accepts either a bare step array or `{ description?, steps }`. */
export function parseMockScript(raw: unknown): MockScript {
  return Array.isArray(raw) ? MockScript.parse({ steps: raw }) : MockScript.parse(raw);
}

export function loadMockScript(file: string): MockScript {
  return parseMockScript(JSON.parse(fs.readFileSync(file, 'utf-8')));
}

export interface MockStepLog {
  index: number;
  kind: string;
  ok: boolean;
  error?: { code: string; message: string };
}

export class MockAgentRuntime implements AgentRuntime {
  readonly id = 'mock';
  /** Outcome of every executed step of the most recent run. */
  log: MockStepLog[] = [];

  private readonly script: MockScript;

  constructor(script: MockScript | MockStep[]) {
    this.script = parseMockScript(script);
  }

  async run(input: AgentRunInput, ctl: AgentRunControl): Promise<AgentRunResult> {
    this.log = [];
    let status: AgentRunResult['status'] = 'completed';
    let error: AgentRunResult['error'];
    let executed = 0;

    for (const [index, step] of this.script.steps.entries()) {
      if (ctl.signal.aborted) {
        status = 'aborted';
        break;
      }
      executed += 1;
      ctl.onProgress({ type: 'turn', turn: executed });
      const kind = 'tool' in step ? step.tool : 'read' in step ? 'Read' : 'note';
      try {
        this.exec(step, ctl);
        this.log.push({ index, kind, ok: true });
        if ('tool' in step || 'read' in step) ctl.onProgress({ type: 'tool', name: kind, ok: true });
        if ('tool' in step && step.tool === 'perspective_started') ctl.onProgress({ type: 'perspective', name: step.args.name, state: 'running' });
        if ('tool' in step && step.tool === 'perspective_done') ctl.onProgress({ type: 'perspective', name: step.args.name, state: 'done' });
      } catch (err) {
        if (err instanceof ToolPolicyError) {
          this.log.push({ index, kind, ok: false, error: { code: err.code, message: err.message } });
          ctl.onProgress({ type: 'tool', name: kind, ok: false, detail: err.code });
        } else if (err instanceof BudgetExceeded) {
          this.log.push({ index, kind, ok: false, error: { code: `budget_${err.budget}`, message: err.message } });
          ctl.onProgress({ type: 'tool', name: kind, ok: false, detail: `budget:${err.budget}` });
          // Per-call refusals are recoverable (the model would retry smaller); the rest end the run.
          if (err.budget !== 'maxReadBytesPerCall') {
            ctl.onProgress({ type: 'budget', budget: err.budget, detail: err.message });
            status = 'budget_exhausted';
            error = { code: `budget_${err.budget}`, message: err.message };
            break;
          }
        } else {
          throw err;
        }
      }
    }
    return {
      status,
      turns: executed,
      usage: {
        runtime: 'mock',
        estimatedBy: 'mock',
        totalCostUsd: 0,
        durationMs: executed * 10,
        apiDurationMs: executed * 5,
        byModel: {
          [input.model.id]: {
            inputTokens: executed * 100,
            outputTokens: executed * 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUsd: 0,
          },
        },
      },
      ...(error ? { error } : {}),
    };
  }

  private exec(step: MockStep, ctl: AgentRunControl): void {
    const host = ctl.tools;
    if ('read' in step) {
      const abs = host.authorizeSnapshotPath(step.read);
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new ToolPolicyError('not_a_file', 'path is not a regular file');
      host.accountRead(abs, st.size);
      return;
    }
    if ('note' in step) {
      ctl.onProgress({ type: 'note', message: step.note });
      return;
    }
    switch (step.tool) {
      case 'omm_write':
        host.ommWrite(step.args.path, step.args.field as OmmField, step.args.content);
        return;
      case 'omm_read':
        host.ommRead(step.args.path, step.args.field as OmmField);
        return;
      case 'omm_list':
        host.ommList(step.args.path);
        return;
      case 'evidence_add':
        host.evidenceAdd({
          elementPath: step.args.elementPath,
          claim: step.args.claim,
          kind: step.args.kind as 'observed' | 'interpretation',
          refs: step.args.refs,
          confidence: (step.args.confidence ?? 'medium') as 'high' | 'medium' | 'low',
          ...(step.args.relationship ? { relationship: step.args.relationship } : {}),
        });
        return;
      case 'coverage_report':
        host.coverageReport(step.args);
        return;
      case 'perspective_started':
        host.perspectiveStarted(step.args.name);
        return;
      case 'perspective_done':
        host.perspectiveDone(step.args.name);
        return;
    }
  }
}
