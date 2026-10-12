/**
 * @archreview/contracts — frozen contracts, version 1.0 (SS00 §6, §8; ADR-011).
 *
 * Rules:
 *  - zod definitions here are the source of truth; JSON Schemas in ../schemas are generated.
 *  - 1.x changes are additive (new optional fields). Anything else is a new major.
 *  - No runtime code other than schema definitions and pure id helpers lives here.
 */
export * from './common.js';
export * from './scan.js';
export * from './artifacts.js';
export * from './ids.js';
