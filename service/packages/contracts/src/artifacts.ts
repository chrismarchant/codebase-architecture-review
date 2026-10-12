import { z } from 'zod';
import {
  ComponentId,
  ElementPath,
  ElementSegment,
  EvidenceId,
  IsoDateTime,
  RelationshipId,
  RepoRelativePath,
  SCHEMA_IDS,
  STUDIO_CAPABILITY,
  Sha1Hex,
  Sha256Hex,
  TrustBoundaryId,
  Uuid,
  OmmField,
} from './common.js';
import { AnalysisBudgets, ProviderUsage } from './scan.js';

// ---------------------------------------------------------------------------
// inventory.json — archreview.inventory/1.0
// ---------------------------------------------------------------------------
export const InventoryFile = z.object({
  path: RepoRelativePath,
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Hex,
  language: z.string().nullable(),
  lines: z.number().int().nonnegative().nullable(),
});
export const ExclusionReason = z.enum([
  'glob_exclude',
  'over_file_byte_cap',
  'over_total_byte_cap',
  'over_file_count_cap',
  'symlink',
  'hardlink',
  'special_file',
  'unsafe_path',
  'binary',
  'submodule',
  'lfs_pointer',
]);
export const Inventory = z.object({
  schema: z.literal(SCHEMA_IDS.inventory),
  commitSha: Sha1Hex,
  snapshotSha256: Sha256Hex,
  files: z.array(InventoryFile),
  excluded: z.array(z.object({ path: z.string(), reason: ExclusionReason, bytes: z.number().int().nonnegative().optional() })),
  totals: z.object({ files: z.number().int(), bytes: z.number().int(), byLanguage: z.record(z.string(), z.number().int()) }),
  generatedAt: IsoDateTime,
});
export type Inventory = z.infer<typeof Inventory>;

// ---------------------------------------------------------------------------
// architecture.json — archreview.architecture/1.0 (SS00 §8.2)
// ---------------------------------------------------------------------------
export const Component = z.object({
  id: ComponentId,
  perspective: ElementSegment,
  path: ElementPath,
  title: z.string().max(256),
  kind: z.enum(['perspective', 'group', 'leaf']),
  /** source locations claimed for this element (from labels and descriptions) */
  paths: z.array(z.string().max(512)),
  fields: z.record(OmmField, z.string()),
  diagram: z.string().nullable(),
  children: z.array(ComponentId),
  evidenceIds: z.array(EvidenceId),
});
export type Component = z.infer<typeof Component>;

export const Relationship = z.object({
  id: RelationshipId,
  from: ComponentId,
  to: ComponentId,
  label: z.string().max(512),
  perspective: ElementSegment,
  /** diagram element path in which the edge was declared */
  declaredIn: ElementPath,
  evidenceIds: z.array(EvidenceId),
});
export type Relationship = z.infer<typeof Relationship>;

export const EntryPoint = z.object({
  componentId: ComponentId,
  kind: z.enum(['http', 'cli', 'queue', 'scheduler', 'library', 'other']),
  description: z.string().max(512).optional(),
  evidenceIds: z.array(EvidenceId),
});

export const TrustBoundary = z.object({
  id: TrustBoundaryId,
  name: z.string().max(256),
  componentIds: z.array(ComponentId),
  basis: z.enum(['observed', 'interpretation']),
  rationale: z.string().max(1024).optional(),
  evidenceIds: z.array(EvidenceId),
});

export const Architecture = z.object({
  schema: z.literal(SCHEMA_IDS.architecture),
  scanId: Uuid,
  repository: z.object({ url: z.string(), commitSha: Sha1Hex }),
  perspectives: z.array(ElementSegment),
  components: z.array(Component),
  relationships: z.array(Relationship),
  entryPoints: z.array(EntryPoint),
  trustBoundaries: z.array(TrustBoundary),
  generatedAt: IsoDateTime,
});
export type Architecture = z.infer<typeof Architecture>;

// ---------------------------------------------------------------------------
// evidence.json — archreview.evidence/1.0 (SS00 §8.3)
// ---------------------------------------------------------------------------
export const EvidenceRef = z.object({
  file: RepoRelativePath,
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbol: z.string().max(256).optional(),
  sha256: Sha256Hex,
});
export const EvidenceSubject = z.union([
  z.object({ componentId: ComponentId }),
  z.object({ relationshipId: RelationshipId }),
  z.object({ trustBoundaryId: TrustBoundaryId }),
]);
export const EvidenceItem = z.object({
  id: EvidenceId,
  subject: EvidenceSubject,
  claim: z.string().max(1024),
  kind: z.enum(['observed', 'interpretation']),
  refs: z.array(EvidenceRef).max(32),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;
export const Evidence = z.object({
  schema: z.literal(SCHEMA_IDS.evidence),
  scanId: Uuid,
  items: z.array(EvidenceItem),
  generatedAt: IsoDateTime,
});
export type Evidence = z.infer<typeof Evidence>;

// ---------------------------------------------------------------------------
// coverage.json — archreview.coverage/1.0 (SS00 §8.4)
// ---------------------------------------------------------------------------
export const Coverage = z.object({
  schema: z.literal(SCHEMA_IDS.coverage),
  scanId: Uuid,
  inventory: z.object({ files: z.number().int(), bytes: z.number().int(), byLanguage: z.record(z.string(), z.number().int()) }),
  read: z.object({ files: z.number().int(), bytes: z.number().int() }),
  referenced: z.object({ files: z.number().int() }),
  excluded: z.array(z.object({ path: z.string(), reason: z.string() })),
  unreadDirectories: z.array(z.object({ path: z.string(), files: z.number().int() })),
  perspectives: z.record(z.string(), z.enum(['done', 'pending', 'skipped_budget', 'skipped_cancel', 'failed'])),
  limits: z.object({ hit: z.array(z.string()), budgets: AnalysisBudgets }),
  agentStatement: z
    .object({ covered: z.array(z.string()), excluded: z.array(z.string()), notes: z.string().max(4096) })
    .nullable(),
  complete: z.boolean(),
  generatedAt: IsoDateTime,
});
export type Coverage = z.infer<typeof Coverage>;

// ---------------------------------------------------------------------------
// validation.json — archreview.validation/1.0
// ---------------------------------------------------------------------------
export const ValidationFinding = z.object({
  level: z.enum(['error', 'warning']),
  rule: z.string(),
  elementPath: ElementPath.nullable(),
  artifact: z.string().nullable(),
  message: z.string().max(1024),
  line: z.number().int().positive().optional(),
});
export const ValidationReport = z.object({
  schema: z.literal(SCHEMA_IDS.validation),
  scanId: Uuid,
  findings: z.array(ValidationFinding),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  generatedAt: IsoDateTime,
});
export type ValidationReport = z.infer<typeof ValidationReport>;

// ---------------------------------------------------------------------------
// manifest.json — archreview.manifest/1.0 (SS00 §8.6)
// ---------------------------------------------------------------------------
export const ManifestArtifact = z.object({
  path: z.string().min(1).max(1024),
  schema: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Hex,
  contentType: z.string(),
});
export const Manifest = z.object({
  schema: z.literal(SCHEMA_IDS.manifest),
  scanId: Uuid,
  attempt: z.number().int().positive(),
  repository: z.object({ url: z.string(), commitSha: Sha1Hex, requestedRef: z.string().nullable(), snapshotSha256: Sha256Hex }),
  service: z.object({ version: z.string(), gitSha: z.string().nullable(), upstreamBaseline: Sha1Hex, ommVersion: z.string() }),
  analysis: z.object({
    runtime: z.string(),
    model: z.string(),
    effort: z.string().nullable(),
    promptBundleSha256: Sha256Hex,
    language: z.string(),
  }),
  usage: ProviderUsage.nullable(),
  budgets: AnalysisBudgets,
  artifacts: z.array(ManifestArtifact),
  outcome: z.enum(['complete', 'partial']),
  createdAt: IsoDateTime,
});
export type Manifest = z.infer<typeof Manifest>;

// ---------------------------------------------------------------------------
// comparison.json — archreview.comparison/1.0 (SS00 §8.7)
// ---------------------------------------------------------------------------
export const MermaidDiff = z.object({
  added_nodes: z.array(z.string()),
  removed_nodes: z.array(z.string()),
  added_edges: z.array(z.string()),
  removed_edges: z.array(z.string()),
  has_changes: z.boolean(),
});
export const Comparison = z.object({
  schema: z.literal(SCHEMA_IDS.comparison),
  comparisonId: Uuid,
  base: z.object({ scanId: Uuid, commitSha: Sha1Hex, manifestSha256: Sha256Hex }),
  head: z.object({ scanId: Uuid, commitSha: Sha1Hex, manifestSha256: Sha256Hex }),
  components: z.object({
    added: z.array(z.object({ id: ComponentId, path: ElementPath, title: z.string() })),
    removed: z.array(z.object({ id: ComponentId, path: ElementPath, title: z.string() })),
    changed: z.array(
      z.object({
        id: ComponentId,
        path: ElementPath,
        changedFields: z.array(OmmField),
        diagramDiff: MermaidDiff.nullable(),
      }),
    ),
  }),
  relationships: z.object({
    added: z.array(z.object({ id: RelationshipId, from: ComponentId, to: ComponentId, label: z.string() })),
    removed: z.array(z.object({ id: RelationshipId, from: ComponentId, to: ComponentId, label: z.string() })),
  }),
  coverageDelta: z.object({
    base: z.object({ readFiles: z.number().int(), complete: z.boolean() }),
    head: z.object({ readFiles: z.number().int(), complete: z.boolean() }),
  }),
  evidenceDelta: z.object({ base: z.number().int(), head: z.number().int() }),
  generatedAt: IsoDateTime,
});
export type Comparison = z.infer<typeof Comparison>;

// ---------------------------------------------------------------------------
// studio-export.json — archreview.studio-export/1.0 (SS00 §12)
// ---------------------------------------------------------------------------
export const StudioExport = z.object({
  schema: z.literal(SCHEMA_IDS.studioExport),
  capability: z.literal(STUDIO_CAPABILITY),
  scanId: Uuid,
  repository: z.object({ url: z.string(), commitSha: Sha1Hex }),
  manifestSha256: Sha256Hex,
  schemaVersions: z.object({ architecture: z.string(), evidence: z.string(), coverage: z.string() }),
  artifactHashes: z.record(z.string(), Sha256Hex),
  components: z.array(
    z.object({ id: ComponentId, perspective: ElementSegment, path: ElementPath, title: z.string(), kind: z.string(), paths: z.array(z.string()) }),
  ),
  entryPoints: z.array(EntryPoint),
  trustBoundaries: z.array(TrustBoundary),
  evidenceSummary: z.object({ observed: z.number().int(), interpretation: z.number().int(), unsupportedComponents: z.number().int() }),
  coverageSummary: z.object({ complete: z.boolean(), readFiles: z.number().int(), inventoryFiles: z.number().int(), limitsHit: z.array(z.string()) }),
  findingsMapping: z.object({
    byPath: z.array(z.object({ pathPrefix: z.string(), componentIds: z.array(ComponentId) })),
  }),
  generatedAt: IsoDateTime,
});
export type StudioExport = z.infer<typeof StudioExport>;

export const RevisionMatch = z.object({
  result: z.enum(['match', 'mismatch', 'unknown']),
  exportSha: Sha1Hex,
  studioSha: Sha1Hex.nullable(),
  message: z.string(),
});
export type RevisionMatch = z.infer<typeof RevisionMatch>;
