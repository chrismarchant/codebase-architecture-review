import { createHash } from 'node:crypto';

/**
 * Stable identifiers (SS00 §8.2). They derive from content that is stable across
 * scans of the same repository, never from timestamps or scan ids.
 */
function short(prefix: string, input: string): string {
  return `${prefix}_${createHash('sha256').update(input).digest('hex').slice(0, 12)}`;
}

/** Component id from the element path "perspective/child/…". */
export function componentIdFor(elementPath: string): string {
  return short('c', `component:${elementPath}`);
}

/** Relationship id from the declaring element path, source and target element ids and label. */
export function relationshipIdFor(declaredIn: string, fromPath: string, toPath: string, label: string): string {
  return short('r', `relationship:${declaredIn}\u0000${fromPath}\u0000${toPath}\u0000${label}`);
}

/** Evidence id from subject, claim and the first reference. */
export function evidenceIdFor(subjectKey: string, claim: string, firstRef: string): string {
  return short('e', `evidence:${subjectKey}\u0000${claim}\u0000${firstRef}`);
}

export function trustBoundaryIdFor(name: string, componentIds: readonly string[]): string {
  return short('tb', `trust:${name}\u0000${[...componentIds].sort().join(',')}`);
}
