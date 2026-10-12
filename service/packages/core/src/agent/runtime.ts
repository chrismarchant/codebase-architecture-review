/**
 * Agent runtime interface (SS00 §4). Frozen in Stage B.
 *
 * The service owns the tool host; a runtime only wires its model loop to it.
 * No runtime may expose a shell, a network tool, or a write path other than
 * the tool host methods below.
 */
import type { AnalysisBudgets, Inventory, OmmField } from '@archreview/contracts';

export interface PromptBundle {
  /** Plain system prompt string (never the SDK's claude_code preset). */
  systemPrompt: string;
  /** The first user turn: task description including perspective catalogue and obligations. */
  taskPrompt: string;
  /** sha256 of systemPrompt + '\0' + taskPrompt, recorded in the manifest. */
  sha256: string;
}

export interface ModelSelection {
  id: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fallbackId?: string;
}

export interface AgentRunInput {
  workspaceRoot: string;
  snapshotDir: string;
  inventory: Inventory;
  perspectivesCompleted: readonly string[];
  language: string;
  budgets: AnalysisBudgets;
  model: ModelSelection;
  promptBundle: PromptBundle;
}

export type AgentProgressEvent =
  | { type: 'turn'; turn: number }
  | { type: 'tool'; name: string; ok: boolean; detail?: string }
  | { type: 'perspective'; name: string; state: 'running' | 'done' }
  | { type: 'budget'; budget: string; detail: string }
  | { type: 'note'; message: string };

export interface AgentRunControl {
  signal: AbortSignal;
  onProgress(evt: AgentProgressEvent): void;
  tools: AnalysisToolHost;
}

export interface AgentRunResult {
  status: 'completed' | 'aborted' | 'budget_exhausted' | 'error';
  turns: number;
  usage: {
    runtime: string;
    estimatedBy: string;
    totalCostUsd?: number;
    durationMs: number;
    apiDurationMs?: number;
    byModel: Record<
      string,
      { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUsd?: number }
    >;
  };
  error?: { code: string; message: string };
}

export interface AgentRuntime {
  readonly id: string;
  run(input: AgentRunInput, ctl: AgentRunControl): Promise<AgentRunResult>;
}

// ---------------------------------------------------------------------------
// Tool host (SS00 §4.2). Service-owned; every runtime routes tool calls here.
// Every method throws ToolPolicyError on a policy violation and BudgetExceeded
// when a budget is exhausted. Both are plain data for the model (returned as a
// tool error), never silently ignored.
// ---------------------------------------------------------------------------
export class ToolPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}
export class BudgetExceeded extends Error {
  constructor(
    public readonly budget: string,
    message: string,
  ) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

export interface EvidenceRefInput {
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

export interface AnalysisToolHost {
  /** Resolves and authorises a snapshot path for Read/Glob/Grep. Returns the absolute real path. */
  authorizeSnapshotPath(p: string): string;
  /** Accounts a read of `bytes` from `file` (after authorizeSnapshotPath). */
  accountRead(file: string, bytes: number): void;

  ommWrite(elementPath: string, field: OmmField, content: string): { bytes: number };
  ommRead(elementPath: string, field: OmmField): string | null;
  ommList(elementPath?: string): string[];

  evidenceAdd(input: {
    elementPath: string;
    relationship?: { fromPath: string; toPath: string; label: string };
    claim: string;
    kind: 'observed' | 'interpretation';
    refs: EvidenceRefInput[];
    confidence: 'high' | 'medium' | 'low';
  }): { id: string };

  coverageReport(input: { covered: string[]; excluded: string[]; notes: string }): void;

  perspectiveStarted(name: string): void;
  perspectiveDone(name: string): void;

  /** Snapshot of counters for coverage.json and progress. */
  stats(): {
    readFiles: number;
    readBytes: number;
    elements: number;
    evidenceItems: number;
    perspectives: Record<string, 'running' | 'done'>;
    limitsHit: string[];
  };
}
