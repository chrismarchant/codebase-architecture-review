import type { AnalysisBudgets } from '@archreview/contracts';

export interface ResolveRequest {
  /** branch, tag or other ref; ignored when `sha` is given */
  ref?: string;
  /** full 40-hex SHA; the resolved commit MUST equal it */
  sha?: string;
  token?: string;
}

export interface ResolvedRef {
  /** full 40-hex commit SHA */
  sha: string;
  /** null when the provider cannot tell */
  defaultBranch: string | null;
  /** null when the provider cannot tell (generic git remotes) */
  isPrivate: boolean | null;
}

export type ExportBudgets = Pick<AnalysisBudgets, 'maxFiles' | 'maxBytes' | 'maxFileBytes'>;
