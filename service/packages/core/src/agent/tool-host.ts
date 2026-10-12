/**
 * Service-owned implementation of the analysis tool host (SS00 §4.2).
 *
 * Every runtime (Claude Agent SDK, mock) routes its tool calls through this class, so
 * validation, budgets and evidence bookkeeping are identical regardless of the model loop.
 * Model-supplied arguments are untrusted: each method validates before it touches disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ElementPath,
  ElementSegment,
  OmmField,
  RepoRelativePath,
  componentIdFor,
  evidenceIdFor,
  relationshipIdFor,
  type AnalysisBudgets,
  type EvidenceItem,
  type Inventory,
} from '@archreview/contracts';
import { BudgetExceeded, ToolPolicyError, type AnalysisToolHost, type EvidenceRefInput } from './runtime.js';
import { createPathPolicy, type PathPolicy } from './path-policy.js';
import { createOmmWriter, type OmmWriter } from '../omm/writer.js';

/** Maximum size of one `.omm` field write. */
export const MAX_FIELD_BYTES = 64 * 1024;
const MAX_CLAIM_CHARS = 1024;
const MAX_LABEL_CHARS = 512;
const MAX_REFS = 32;
const MAX_COVERAGE_ENTRIES = 5_000;
const MAX_COVERAGE_ENTRY_CHARS = 1024;
const MAX_COVERAGE_NOTES_CHARS = 4096;

/** Evidence attached to a relationship, keyed the way relationship ids are derived (SS00 §8.2). */
export interface RelationshipEvidence {
  declaredIn: string;
  fromPath: string;
  toPath: string;
  label: string;
  relationshipId: string;
  evidenceIds: string[];
}

export interface DrainedEvidence {
  items: EvidenceItem[];
  relationships: RelationshipEvidence[];
}

export interface CoverageStatement {
  covered: string[];
  excluded: string[];
  notes: string;
}

export interface ToolHostOptions {
  /** Immutable snapshot (read side). */
  snapshotDir: string;
  /** Output directory; `.omm/` lives directly inside it. */
  outDir: string;
  inventory: Inventory;
  budgets: Pick<AnalysisBudgets, 'maxDepth' | 'maxElements' | 'maxReadBytesPerCall' | 'maxReadBytesTotal'>;
  /** Content language recorded in `.omm/config.yaml`. */
  language?: string;
}

function truncated(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export class ArchreviewToolHost implements AnalysisToolHost {
  readonly policy: PathPolicy;
  readonly writer: OmmWriter;

  private readonly inventoryFiles: Map<string, Inventory['files'][number]>;
  private readonly budgets: ToolHostOptions['budgets'];

  private readonly elements = new Set<string>();
  private readonly readPathsSet = new Set<string>();
  private readBytes = 0;
  private evidenceCount = 0;
  private items = new Map<string, EvidenceItem>();
  private relationships = new Map<string, RelationshipEvidence>();
  private perspectiveStates: Record<string, 'running' | 'done'> = {};
  private readonly limits = new Set<string>();
  private statement: CoverageStatement | null = null;

  constructor(opts: ToolHostOptions) {
    this.policy = createPathPolicy(opts.snapshotDir);
    this.writer = createOmmWriter(opts.outDir);
    this.budgets = opts.budgets;
    this.inventoryFiles = new Map(opts.inventory.files.map((f) => [f.path, f]));
    // Resume: elements written by an earlier attempt count against the cap.
    for (const p of this.writer.allElementPaths()) this.elements.add(p);
    if (opts.language) this.writer.setLanguage(opts.language);
  }

  // ---------------------------------------------------------------------------
  // Reads of the snapshot
  // ---------------------------------------------------------------------------
  authorizeSnapshotPath(p: string): string {
    return this.policy.authorize(p);
  }

  accountRead(file: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) throw new ToolPolicyError('invalid_read', 'read size must be a non-negative number');
    // `file` is expected to be an authorised absolute path; re-check so a caller bug cannot widen the policy.
    const abs = this.policy.authorize(file);
    if (bytes > this.budgets.maxReadBytesPerCall) {
      throw new BudgetExceeded(
        'maxReadBytesPerCall',
        `read of ${bytes} bytes exceeds the per-call limit of ${this.budgets.maxReadBytesPerCall} bytes; read the file in smaller ranges (offset/limit)`,
      );
    }
    if (this.readBytes + bytes > this.budgets.maxReadBytesTotal) {
      this.limits.add('maxReadBytesTotal');
      throw new BudgetExceeded('maxReadBytesTotal', `total read budget of ${this.budgets.maxReadBytesTotal} bytes is exhausted; finish the analysis with what has been read`);
    }
    this.readBytes += bytes;
    this.readPathsSet.add(path.relative(this.policy.root, abs).split(path.sep).join('/'));
  }

  // ---------------------------------------------------------------------------
  // .omm tree
  // ---------------------------------------------------------------------------
  private parseElementPath(elementPath: unknown, what = 'path'): string {
    const parsed = ElementPath.safeParse(elementPath);
    if (!parsed.success) {
      throw new ToolPolicyError(
        'invalid_element_path',
        `${what} ${JSON.stringify(typeof elementPath === 'string' ? truncated(elementPath) : elementPath)} is not a valid element path: lowercase kebab-case segments (a-z, 0-9, "-", max 64 chars) separated by "/"`,
      );
    }
    return parsed.data;
  }

  private parseField(field: unknown): OmmField {
    const parsed = OmmField.safeParse(field);
    if (!parsed.success) {
      throw new ToolPolicyError('invalid_field', `field must be one of ${OmmField.options.join(', ')}`);
    }
    return parsed.data;
  }

  ommWrite(elementPath: string, field: OmmField, content: string): { bytes: number } {
    const p = this.parseElementPath(elementPath);
    const depth = p.split('/').length;
    if (depth > this.budgets.maxDepth) {
      throw new ToolPolicyError('depth_exceeded', `element depth ${depth} exceeds the maximum of ${this.budgets.maxDepth}; keep deeper structure in the parent's description instead`);
    }
    const f = this.parseField(field);
    if (typeof content !== 'string') throw new ToolPolicyError('invalid_content', 'content must be a string');
    if (content.includes('\0')) throw new ToolPolicyError('invalid_content', 'content must not contain NUL bytes');
    const size = Buffer.byteLength(content, 'utf-8');
    if (size > MAX_FIELD_BYTES) {
      throw new ToolPolicyError('content_too_large', `content is ${size} bytes; the limit is ${MAX_FIELD_BYTES} bytes per field`);
    }
    if (!this.elements.has(p) && this.elements.size >= this.budgets.maxElements) {
      this.limits.add('maxElements');
      throw new BudgetExceeded('maxElements', `the element limit of ${this.budgets.maxElements} is reached; do not create further elements`);
    }
    const bytes = this.writer.write(p, f, content);
    this.elements.add(p);
    return { bytes };
  }

  ommRead(elementPath: string, field: OmmField): string | null {
    return this.writer.read(this.parseElementPath(elementPath), this.parseField(field));
  }

  ommList(elementPath?: string): string[] {
    if (elementPath === undefined || elementPath === '') return this.writer.list();
    return this.writer.list(this.parseElementPath(elementPath));
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------
  private validateRef(ref: EvidenceRefInput): { file: string; startLine?: number; endLine?: number; symbol?: string; sha256: string } {
    const file = RepoRelativePath.safeParse(ref?.file);
    if (!file.success) {
      throw new ToolPolicyError('invalid_ref', `evidence file ${JSON.stringify(truncated(String(ref?.file)))} is not a repository-relative path`);
    }
    const entry = this.inventoryFiles.get(file.data);
    if (!entry) {
      throw new ToolPolicyError('unknown_file', `evidence file ${JSON.stringify(truncated(file.data))} is not in the repository inventory`);
    }
    const { startLine, endLine, symbol } = ref;
    if (startLine === undefined && endLine !== undefined) {
      throw new ToolPolicyError('invalid_line_range', 'endLine requires startLine');
    }
    if (startLine !== undefined) {
      if (!Number.isInteger(startLine) || startLine < 1) throw new ToolPolicyError('invalid_line_range', 'startLine must be a positive integer');
      const end = endLine ?? startLine;
      if (!Number.isInteger(end) || end < startLine) throw new ToolPolicyError('invalid_line_range', 'endLine must be an integer >= startLine');
      if (entry.lines === null) {
        throw new ToolPolicyError('invalid_line_range', `line ranges cannot be verified for ${file.data} (no line count in the inventory); cite the file without lines`);
      }
      if (end > entry.lines) {
        throw new ToolPolicyError('invalid_line_range', `line range ${startLine}-${end} is beyond the end of ${file.data} (${entry.lines} lines)`);
      }
    }
    if (symbol !== undefined && (typeof symbol !== 'string' || symbol.length > 256 || symbol.includes('\0'))) {
      throw new ToolPolicyError('invalid_ref', 'symbol must be a string of at most 256 characters');
    }
    return {
      file: file.data,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(symbol !== undefined ? { symbol } : {}),
      sha256: entry.sha256,
    };
  }

  evidenceAdd(input: Parameters<AnalysisToolHost['evidenceAdd']>[0]): { id: string } {
    const elementPath = this.parseElementPath(input.elementPath, 'elementPath');
    if (typeof input.claim !== 'string' || input.claim.trim() === '' || input.claim.length > MAX_CLAIM_CHARS || input.claim.includes('\0')) {
      throw new ToolPolicyError('invalid_claim', `claim must be a non-empty string of at most ${MAX_CLAIM_CHARS} characters`);
    }
    if (input.kind !== 'observed' && input.kind !== 'interpretation') {
      throw new ToolPolicyError('invalid_kind', 'kind must be "observed" or "interpretation"');
    }
    if (input.confidence !== 'high' && input.confidence !== 'medium' && input.confidence !== 'low') {
      throw new ToolPolicyError('invalid_confidence', 'confidence must be "high", "medium" or "low"');
    }
    if (!Array.isArray(input.refs) || input.refs.length === 0 || input.refs.length > MAX_REFS) {
      throw new ToolPolicyError('invalid_ref', `refs must contain between 1 and ${MAX_REFS} references`);
    }
    const refs = input.refs.map((r) => this.validateRef(r));

    let subjectId: string;
    let subject: EvidenceItem['subject'];
    let rel: RelationshipEvidence | undefined;
    if (input.relationship) {
      const fromPath = this.parseElementPath(input.relationship.fromPath, 'relationship.fromPath');
      const toPath = this.parseElementPath(input.relationship.toPath, 'relationship.toPath');
      const label = input.relationship.label;
      if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL_CHARS || label.includes('\0')) {
        throw new ToolPolicyError('invalid_relationship', `relationship label must be a non-empty string of at most ${MAX_LABEL_CHARS} characters`);
      }
      subjectId = relationshipIdFor(elementPath, fromPath, toPath, label);
      subject = { relationshipId: subjectId };
      const key = `${elementPath}\0${fromPath}\0${toPath}\0${label}`;
      rel = this.relationships.get(key) ?? { declaredIn: elementPath, fromPath, toPath, label, relationshipId: subjectId, evidenceIds: [] };
      this.relationships.set(key, rel);
    } else {
      subjectId = componentIdFor(elementPath);
      subject = { componentId: subjectId };
    }

    const first = refs[0] as (typeof refs)[number];
    const id = evidenceIdFor(subjectId, input.claim, `${first.file}:${first.startLine ?? ''}-${first.endLine ?? ''}`);
    if (!this.items.has(id)) {
      this.items.set(id, { id, subject, claim: input.claim, kind: input.kind, refs, confidence: input.confidence });
      this.evidenceCount += 1;
    }
    if (rel && !rel.evidenceIds.includes(id)) rel.evidenceIds.push(id);
    return { id };
  }

  /**
   * Returns the evidence collected so far and clears it (callers persist what they receive).
   * Not part of the frozen interface; the pipeline calls it on the concrete class.
   */
  drain(): DrainedEvidence {
    const result: DrainedEvidence = { items: [...this.items.values()], relationships: [...this.relationships.values()] };
    this.items = new Map();
    this.relationships = new Map();
    return result;
  }

  // ---------------------------------------------------------------------------
  // Coverage, perspectives, stats
  // ---------------------------------------------------------------------------
  coverageReport(input: { covered: string[]; excluded: string[]; notes: string }): void {
    const list = (v: unknown, name: string): string[] => {
      if (!Array.isArray(v) || v.length > MAX_COVERAGE_ENTRIES) {
        throw new ToolPolicyError('invalid_coverage', `${name} must be an array of at most ${MAX_COVERAGE_ENTRIES} strings`);
      }
      for (const e of v) {
        if (typeof e !== 'string' || e.length === 0 || e.length > MAX_COVERAGE_ENTRY_CHARS || e.includes('\0')) {
          throw new ToolPolicyError('invalid_coverage', `${name} entries must be non-empty strings of at most ${MAX_COVERAGE_ENTRY_CHARS} characters`);
        }
      }
      return [...(v as string[])];
    };
    if (typeof input.notes !== 'string' || input.notes.length > MAX_COVERAGE_NOTES_CHARS || input.notes.includes('\0')) {
      throw new ToolPolicyError('invalid_coverage', `notes must be a string of at most ${MAX_COVERAGE_NOTES_CHARS} characters`);
    }
    this.statement = { covered: list(input.covered, 'covered'), excluded: list(input.excluded, 'excluded'), notes: input.notes };
  }

  /** The agent's last coverage statement (null when none was made). */
  getCoverageStatement(): CoverageStatement | null {
    return this.statement ? { ...this.statement, covered: [...this.statement.covered], excluded: [...this.statement.excluded] } : null;
  }

  /** Snapshot-relative POSIX paths of every file the agent actually read, sorted. */
  readPaths(): string[] {
    return [...this.readPathsSet].sort();
  }

  perspectiveStarted(name: string): void {
    const n = this.parsePerspective(name);
    this.perspectiveStates[n] = 'running';
  }

  perspectiveDone(name: string): void {
    const n = this.parsePerspective(name);
    this.perspectiveStates[n] = 'done';
  }

  private parsePerspective(name: unknown): string {
    const parsed = ElementSegment.safeParse(name);
    if (!parsed.success) throw new ToolPolicyError('invalid_perspective', 'perspective name must be a lowercase kebab-case segment');
    return parsed.data;
  }

  stats(): ReturnType<AnalysisToolHost['stats']> {
    return {
      readFiles: this.readPathsSet.size,
      readBytes: this.readBytes,
      elements: this.elements.size,
      evidenceItems: this.evidenceCount,
      perspectives: { ...this.perspectiveStates },
      limitsHit: [...this.limits],
    };
  }

  /** Size helper for runtimes that account a Read: regular files only. */
  statRegularFile(abs: string): number {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new ToolPolicyError('not_a_file', 'path is not a regular file');
    return st.size;
  }
}

export function createToolHost(opts: ToolHostOptions): ArchreviewToolHost {
  return new ArchreviewToolHost(opts);
}
