// Barrel for the inventory module (SS00 §3.2 stage 3, §8.1).
export { buildInventory, compileExcludeGlobs, countLines, DEFAULT_EXCLUDE_GLOBS, type BuildInventoryOptions } from './builder.js';
export { isLockfile, languageForPath, LOCKFILE_LANGUAGE } from './language.js';
