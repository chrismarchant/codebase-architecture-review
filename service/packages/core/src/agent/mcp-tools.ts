/**
 * In-process MCP server exposing the tool host to the Claude Agent SDK (ADR-004).
 *
 * Handlers contain no policy of their own: they delegate to the tool host and convert
 * ToolPolicyError / BudgetExceeded into `isError` results so the model sees the reason and
 * can correct itself. Unexpected errors are reported generically (no stack traces, no paths).
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { OmmField } from '@archreview/contracts';
import { BudgetExceeded, ToolPolicyError, type AnalysisToolHost } from './runtime.js';

export const MCP_SERVER_NAME = 'archreview';
export const MCP_TOOL_NAMES = [
  'omm_write',
  'omm_read',
  'omm_list',
  'evidence_add',
  'coverage_report',
  'perspective_started',
  'perspective_done',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Fully qualified name the SDK gives a tool of our server. */
export const mcpToolName = (name: McpToolName): string => `mcp__${MCP_SERVER_NAME}__${name}`;
export const isArchreviewMcpTool = (fullName: string): boolean =>
  (MCP_TOOL_NAMES as readonly string[]).some((n) => fullName === mcpToolName(n as McpToolName));

export interface McpToolHooks {
  /** Called after every tool call with the outcome (never with file contents). */
  onTool?(evt: { name: McpToolName; ok: boolean; detail?: string }): void;
  /** Called when a call fails with BudgetExceeded. */
  onBudget?(err: BudgetExceeded): void;
  onPerspective?(name: string, state: 'running' | 'done'): void;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const failure = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

const EvidenceRefSchema = z.object({
  file: z.string().describe('Repository-relative POSIX path of a file that exists in the snapshot'),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbol: z.string().max(256).optional(),
});

export function createArchreviewMcpServer(host: AnalysisToolHost, hooks: McpToolHooks = {}): McpSdkServerConfigWithInstance {
  async function run<A>(name: McpToolName, args: A, fn: (a: A) => string): Promise<ToolResult> {
    try {
      const out = fn(args);
      hooks.onTool?.({ name, ok: true });
      return text(out);
    } catch (err) {
      if (err instanceof ToolPolicyError) {
        hooks.onTool?.({ name, ok: false, detail: err.code });
        return failure(`${err.code}: ${err.message}`);
      }
      if (err instanceof BudgetExceeded) {
        hooks.onTool?.({ name, ok: false, detail: `budget:${err.budget}` });
        hooks.onBudget?.(err);
        return failure(`budget_exceeded (${err.budget}): ${err.message}`);
      }
      hooks.onTool?.({ name, ok: false, detail: 'internal_error' });
      return failure('internal_error: the tool failed unexpectedly; continue with a different approach');
    }
  }

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: [
      tool(
        'omm_write',
        'Write one field of an .omm element. path is "perspective" or "perspective/child/…" (lowercase kebab-case). Equivalent of `omm write <path> <field>`.',
        { path: z.string(), field: OmmField, content: z.string() },
        (a) => run('omm_write', a, ({ path, field, content }) => `wrote ${path}/${field} (${host.ommWrite(path, field, content).bytes} bytes)`),
      ),
      tool(
        'omm_read',
        'Read back a field previously written with omm_write. Returns an empty result when the field does not exist.',
        { path: z.string(), field: OmmField },
        (a) => run('omm_read', a, ({ path, field }) => host.ommRead(path, field) ?? '(not written)'),
      ),
      tool(
        'omm_list',
        'List perspectives (no path) or the child elements of a perspective or element.',
        { path: z.string().optional() },
        (a) =>
          run('omm_list', a, ({ path }) => {
            const names = host.ommList(path);
            return names.length === 0 ? '(none)' : names.join('\n');
          }),
      ),
      tool(
        'evidence_add',
        'Record evidence for an element (or for a relationship declared in the diagram of elementPath). Every claim needs file references; line ranges must lie within the file.',
        {
          elementPath: z.string(),
          claim: z.string().max(1024),
          kind: z.enum(['observed', 'interpretation']),
          refs: z.array(EvidenceRefSchema).min(1).max(32),
          confidence: z.enum(['high', 'medium', 'low']).optional(),
          relationship: z.object({ fromPath: z.string(), toPath: z.string(), label: z.string().max(512) }).optional(),
        },
        (a) =>
          run('evidence_add', a, (v) => {
            const { id } = host.evidenceAdd({
              elementPath: v.elementPath,
              claim: v.claim,
              kind: v.kind,
              refs: v.refs,
              confidence: v.confidence ?? 'medium',
              ...(v.relationship ? { relationship: v.relationship } : {}),
            });
            return `recorded evidence ${id}`;
          }),
      ),
      tool(
        'coverage_report',
        'State what you covered and what you left out. Call once near the end; the last call wins. Be honest: unread files are not covered.',
        { covered: z.array(z.string()), excluded: z.array(z.string()), notes: z.string().max(4096) },
        (a) =>
          run('coverage_report', a, (v) => {
            host.coverageReport(v);
            return 'coverage statement recorded';
          }),
      ),
      tool(
        'perspective_started',
        'Announce that you are starting a perspective (for progress reporting).',
        { name: z.string() },
        (a) =>
          run('perspective_started', a, ({ name }) => {
            host.perspectiveStarted(name);
            hooks.onPerspective?.(name, 'running');
            return `perspective ${name} started`;
          }),
      ),
      tool(
        'perspective_done',
        'Announce that a perspective is complete (all elements written, evidence added).',
        { name: z.string() },
        (a) =>
          run('perspective_done', a, ({ name }) => {
            host.perspectiveDone(name);
            hooks.onPerspective?.(name, 'done');
            return `perspective ${name} done`;
          }),
      ),
    ],
  });
}
