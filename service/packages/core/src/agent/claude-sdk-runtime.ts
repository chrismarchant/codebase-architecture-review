/**
 * Claude Agent SDK runtime (ADR-004, SS00 §4.3, §5.3).
 *
 * The option object is built by the pure function `buildSdkOptions` so tests can assert the
 * exact security-relevant configuration without launching the SDK. The runtime itself only
 * wires the SDK message stream to progress events, usage and a status.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  query as sdkQuery,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  BudgetExceeded,
  ToolPolicyError,
  type AgentProgressEvent,
  type AgentRunControl,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
  type AnalysisToolHost,
} from './runtime.js';
import { createArchreviewMcpServer, isArchreviewMcpTool, type McpToolHooks } from './mcp-tools.js';

export const BUILTIN_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'KillShell',
  'BashOutput',
] as const;

/** Budgets whose exhaustion ends the analysis as `budget_exhausted` rather than as a tool error. */
const RUN_ENDING_BUDGETS = new Set(['maxReadBytesTotal', 'maxElements']);

/** Conservative bytes-per-line estimate used when Read is called with a line `limit`. */
const ESTIMATED_BYTES_PER_LINE = 200;

export interface SdkEnvConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface SdkOptionsDeps extends SdkEnvConfig {
  /** Fresh, empty directory used as HOME (no user settings, credentials or caches are visible). */
  homeDir: string;
  /** Aborted when `ctl.signal` aborts (bridged by the runtime). */
  abortController: AbortController;
  /** Called when a built-in tool call hits a run-ending budget. */
  onBudget?: (err: BudgetExceeded) => void;
  /** Called with every built-in tool decision (for progress events). */
  onToolDecision?: (evt: { name: string; ok: boolean; detail?: string }) => void;
}

// ---------------------------------------------------------------------------
// canUseTool
// ---------------------------------------------------------------------------
const deny = (message: string, interrupt = false): PermissionResult => ({ behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}) });

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Builds the permission callback. Allowed calls are returned with `updatedInput` carrying the
 * absolute, authorised paths, so the built-in tool reads exactly what was authorised (the SDK
 * resolves relative paths against `cwd`, which is the workspace root and not the snapshot).
 */
export function createCanUseTool(
  host: AnalysisToolHost,
  snapshotDir: string,
  hooks: Pick<SdkOptionsDeps, 'onBudget' | 'onToolDecision'> = {},
): CanUseTool {
  const root = host.authorizeSnapshotPath(snapshotDir);

  const decide = (name: string, fn: () => PermissionResult): PermissionResult => {
    try {
      const r = fn();
      hooks.onToolDecision?.({ name, ok: r.behavior === 'allow' });
      return r;
    } catch (err) {
      if (err instanceof ToolPolicyError) {
        hooks.onToolDecision?.({ name, ok: false, detail: err.code });
        return deny(`${err.code}: ${err.message}`);
      }
      if (err instanceof BudgetExceeded) {
        const ending = RUN_ENDING_BUDGETS.has(err.budget);
        if (ending) hooks.onBudget?.(err);
        hooks.onToolDecision?.({ name, ok: false, detail: `budget:${err.budget}` });
        return deny(`budget_exceeded (${err.budget}): ${err.message}`, ending);
      }
      hooks.onToolDecision?.({ name, ok: false, detail: 'internal_error' });
      return deny('internal_error: the call could not be authorised');
    }
  };

  return async (toolName, input) => {
    if (isArchreviewMcpTool(toolName)) return { behavior: 'allow', updatedInput: input };

    switch (toolName) {
      case 'Read':
        return decide(toolName, () => {
          const filePath = str(input.file_path);
          if (!filePath) throw new ToolPolicyError('path_invalid', 'Read requires file_path');
          const abs = host.authorizeSnapshotPath(filePath);
          let size: number | null = null;
          try {
            const st = fs.statSync(abs);
            if (!st.isFile()) throw new ToolPolicyError('not_a_file', 'path is not a regular file; use Glob to list directories');
            size = st.size;
          } catch (err) {
            if (err instanceof ToolPolicyError) throw err;
            // Missing file: let the tool report "not found"; nothing is read, nothing is accounted.
          }
          if (size !== null) {
            const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0 ? input.limit : null;
            host.accountRead(abs, limit !== null ? Math.min(size, limit * ESTIMATED_BYTES_PER_LINE) : size);
          }
          return { behavior: 'allow', updatedInput: { ...input, file_path: abs } };
        });
      case 'Glob':
        return decide(toolName, () => {
          const pattern = str(input.pattern);
          if (!pattern) throw new ToolPolicyError('path_invalid', 'Glob requires pattern');
          const base = str(input.path) ? host.authorizeSnapshotPath(input.path as string) : root;
          // Relative patterns are expanded under `base`; absolute patterns must authorise on their own.
          if (pattern.startsWith('/')) host.authorizeSnapshotPath(pattern);
          else host.authorizeSnapshotPath(`${base}/${pattern}`);
          return { behavior: 'allow', updatedInput: { ...input, path: base, pattern } };
        });
      case 'Grep':
        return decide(toolName, () => {
          // `pattern` is a regular expression over file contents, not a path.
          const base = str(input.path) ? host.authorizeSnapshotPath(input.path as string) : root;
          const globFilter = str(input.glob);
          if (globFilter) host.authorizeSnapshotPath(globFilter.startsWith('/') ? globFilter : `${base}/${globFilter}`);
          return { behavior: 'allow', updatedInput: { ...input, path: base } };
        });
      default:
        hooks.onToolDecision?.({ name: toolName, ok: false, detail: 'tool_not_allowed' });
        return deny(`Tool ${JSON.stringify(toolName.slice(0, 64))} is not available in this environment. Use Read, Glob, Grep and the archreview tools only.`);
    }
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export function buildSdkOptions(
  input: AgentRunInput,
  ctl: Pick<AgentRunControl, 'tools'>,
  server: McpSdkServerConfigWithInstance,
  deps: SdkOptionsDeps,
): Options {
  // The environment is built from scratch (SS00 §5.3): never spread process.env, so a database
  // URL, bucket keys, retrieval tokens or wake secrets of the runner cannot reach the agent process.
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: deps.apiKey,
    ...(deps.baseUrl ? { ANTHROPIC_BASE_URL: deps.baseUrl } : {}),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    HOME: deps.homeDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  return {
    cwd: input.workspaceRoot,
    tools: [...BUILTIN_READ_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    permissionMode: 'default',
    // Deviation from the brief, which lists `permissionPrompts: 'none'`: with 'none' the SDK never
    // calls canUseTool, so the snapshot path policy and read budgets would not run at all (and the
    // in-process MCP tools would be denied). 'host' keeps every decision in canUseTool above.
    permissionPrompts: 'host',
    canUseTool: createCanUseTool(ctl.tools, input.snapshotDir, deps),
    systemPrompt: input.promptBundle.systemPrompt,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { archreview: server },
    plugins: [],
    skills: [],
    model: input.model.id,
    ...(input.model.fallbackId ? { fallbackModel: input.model.fallbackId } : {}),
    ...(input.model.effort ? { effort: input.model.effort } : {}),
    maxTurns: input.budgets.maxTurns,
    maxBudgetUsd: input.budgets.maxBudgetUsd,
    abortController: deps.abortController,
    env,
    persistSession: false,
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------
export interface ClaudeAgentSdkRuntimeConfig extends SdkEnvConfig {
  /** Directory under which per-run HOME directories are created (default: os.tmpdir()). */
  tmpRoot?: string;
  /** Test seam; defaults to the SDK's `query`. Production code never sets it. */
  queryImpl?: (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
}

function mapUsage(result: SDKResultMessage | null, startedAt: number): AgentRunResult['usage'] {
  const byModel: AgentRunResult['usage']['byModel'] = {};
  if (result) {
    for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
      byModel[model] = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadInputTokens: u.cacheReadInputTokens,
        cacheCreationInputTokens: u.cacheCreationInputTokens,
        costUsd: u.costUSD,
      };
    }
  }
  return {
    runtime: 'claude-agent-sdk',
    estimatedBy: 'claude-agent-sdk',
    ...(result ? { totalCostUsd: result.total_cost_usd, apiDurationMs: result.duration_api_ms } : {}),
    durationMs: result ? result.duration_ms : Date.now() - startedAt,
    byModel,
  };
}

export class ClaudeAgentSdkRuntime implements AgentRuntime {
  readonly id = 'claude-agent-sdk';

  constructor(private readonly config: ClaudeAgentSdkRuntimeConfig) {
    if (!config.apiKey) throw new Error('ClaudeAgentSdkRuntime requires an API key');
  }

  async run(input: AgentRunInput, ctl: AgentRunControl): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const homeDir = fs.mkdtempSync(path.join(this.config.tmpRoot ?? os.tmpdir(), 'archreview-agent-home-'));
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort();
    if (ctl.signal.aborted) abortController.abort();
    else ctl.signal.addEventListener('abort', onAbort, { once: true });

    let budgetHit: BudgetExceeded | null = null;
    const emit = (evt: AgentProgressEvent): void => {
      try {
        ctl.onProgress(evt);
      } catch {
        // A faulty progress consumer must not break the analysis.
      }
    };
    const noteBudget = (err: BudgetExceeded): void => {
      if (!RUN_ENDING_BUDGETS.has(err.budget)) return;
      budgetHit ??= err;
      emit({ type: 'budget', budget: err.budget, detail: err.message });
    };
    const mcpHooks: McpToolHooks = {
      onTool: (e) => emit({ type: 'tool', name: e.name, ok: e.ok, ...(e.detail ? { detail: e.detail } : {}) }),
      onBudget: noteBudget,
      onPerspective: (name, state) => emit({ type: 'perspective', name, state }),
    };

    let turns = 0;
    const seenMessageIds = new Set<string>();
    let result: SDKResultMessage | null = null;
    let thrown: unknown = null;

    try {
      const server = createArchreviewMcpServer(ctl.tools, mcpHooks);
      const options = buildSdkOptions(input, ctl, server, {
        apiKey: this.config.apiKey,
        ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
        homeDir,
        abortController,
        onBudget: noteBudget,
        onToolDecision: (e) => {
          // MCP tool outcomes are reported by the MCP hooks; here only built-ins and denials.
          if (!isArchreviewMcpTool(e.name)) emit({ type: 'tool', name: e.name, ok: e.ok, ...(e.detail ? { detail: e.detail } : {}) });
        },
      });
      const q = (this.config.queryImpl ?? sdkQuery)({ prompt: input.promptBundle.taskPrompt, options });
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          if (msg.parent_tool_use_id) continue;
          const id = msg.message?.id;
          if (typeof id === 'string' && !seenMessageIds.has(id)) {
            seenMessageIds.add(id);
            turns += 1;
            emit({ type: 'turn', turn: turns });
          }
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    } catch (err) {
      thrown = err;
    } finally {
      ctl.signal.removeEventListener('abort', onAbort);
      try {
        fs.rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // best effort; the directory is empty apart from SDK scratch files
      }
    }

    const usage = mapUsage(result, startedAt);
    const finalTurns = result?.num_turns ?? turns;
    const aborted = ctl.signal.aborted;
    const hostBudget = budgetHit as BudgetExceeded | null;

    if (result?.subtype === 'success' && !result.is_error) {
      if (hostBudget && !aborted) {
        return { status: 'budget_exhausted', turns: finalTurns, usage, error: { code: `budget_${hostBudget.budget}`, message: hostBudget.message } };
      }
      return { status: 'completed', turns: finalTurns, usage };
    }
    if (aborted) return { status: 'aborted', turns: finalTurns, usage };
    if (result?.subtype === 'error_max_turns' || result?.subtype === 'error_max_budget_usd') {
      return { status: 'budget_exhausted', turns: finalTurns, usage, error: { code: result.subtype, message: `${result.subtype}: run stopped by its budget` } };
    }
    if (hostBudget) {
      return { status: 'budget_exhausted', turns: finalTurns, usage, error: { code: `budget_${hostBudget.budget}`, message: hostBudget.message } };
    }
    if (thrown) {
      // Error text can contain request details; keep only the class and a short message.
      const e = thrown as Error;
      return { status: 'error', turns: finalTurns, usage, error: { code: 'sdk_error', message: `${e?.name ?? 'Error'}: ${String(e?.message ?? thrown).slice(0, 300)}` } };
    }
    if (result) {
      const detail = result.subtype === 'success' ? 'the model call ended with an error' : (result.errors ?? []).join('; ');
      return { status: 'error', turns: finalTurns, usage, error: { code: result.subtype === 'success' ? 'api_error' : result.subtype, message: detail.slice(0, 500) || result.subtype } };
    }
    return { status: 'error', turns: finalTurns, usage, error: { code: 'no_result', message: 'the SDK stream ended without a result message' } };
  }
}
