// Barrel for the retrieval module (SS00 §3.2 stages 1-2, §5.2, §5.3; ADR-010).
export * from './errors.js';
export * from './types.js';
export {
  assertPublicAddress,
  hostMatchesAllowlist,
  isNonPublicAddress,
  parseHostAllowlist,
  parseRepositoryUrl,
  type LookupFn,
  type ParsedRepositoryUrl,
  type RepositoryProvider,
} from './url-policy.js';
export { resolveGithub, type FetchFn, type GithubResolveOptions } from './providers/github.js';
export { parseLsRemote, pickRef, resolveGeneric, type GenericResolveOptions, type LsRemoteEntry } from './providers/generic-git.js';
export { resolveRepository, type ResolveOptions, type ResolvedRepository } from './resolver.js';
export { exportCommit, type ExportOptions, type ExportResult } from './exporter.js';
export {
  computeSnapshotSha256,
  extractTarStream,
  makeTreeReadOnly,
  makeTreeWritable,
  parseGitmodulesPaths,
  sanitizeEntryPath,
  MAX_EXCLUDED_RECORDS,
  type Exclusion,
  type ExtractResult,
  type ExtractedFile,
} from './safe-extract.js';
