import { z } from 'zod';

/** Contract version constants. A breaking change bumps the major and gets a new id. */
export const SCHEMA_IDS = {
  inventory: 'archreview.inventory/1.0',
  architecture: 'archreview.architecture/1.0',
  evidence: 'archreview.evidence/1.0',
  coverage: 'archreview.coverage/1.0',
  validation: 'archreview.validation/1.0',
  manifest: 'archreview.manifest/1.0',
  comparison: 'archreview.comparison/1.0',
  studioExport: 'archreview.studio-export/1.0',
} as const;
export type SchemaId = (typeof SCHEMA_IDS)[keyof typeof SCHEMA_IDS];

export const API_VERSION = 'v1' as const;

/** Proposed Security Studio capability identifier (not an existing Studio capability). */
export const STUDIO_CAPABILITY = 'architecture.scan.readonly' as const;

export const Uuid = z.uuid();
export const Sha1Hex = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-character lowercase hex SHA-1');
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-character lowercase hex SHA-256');
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Element path segment as upstream expects (kebab-case directory name). */
export const ElementSegment = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'kebab-case segment');
/** Element path: perspective[/child[/grandchild…]] */
export const ElementPath = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63})*$/, 'kebab-case path with / separators');

/** Upstream field names (src/types.ts VALID_FIELDS). Kept in sync by a parity test. */
export const OmmField = z.enum(['description', 'diagram', 'constraint', 'concern', 'context', 'todo', 'note']);
export type OmmField = z.infer<typeof OmmField>;

/** Repository-relative POSIX path with no traversal. */
export const RepoRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '' || s === '.'), {
    message: 'repository-relative POSIX path without ".", ".." or empty segments',
  });

export const ComponentId = z.string().regex(/^c_[0-9a-f]{12}$/);
export const RelationshipId = z.string().regex(/^r_[0-9a-f]{12}$/);
export const EvidenceId = z.string().regex(/^e_[0-9a-f]{12}$/);
export const TrustBoundaryId = z.string().regex(/^tb_[0-9a-f]{12}$/);

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
