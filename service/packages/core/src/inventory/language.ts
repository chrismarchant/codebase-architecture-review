/** Extension / filename -> language map used by the inventory (SS00 §8.1). Names are lower-case, stable identifiers. */

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', dart: 'dart', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hs: 'haskell', clj: 'clojure', ml: 'ocaml', fs: 'fsharp', vue: 'vue', svelte: 'svelte',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', bat: 'batch',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', tf: 'terraform', hcl: 'hcl',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', ini: 'ini', cfg: 'ini', env: 'dotenv',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', rst: 'restructuredtext', txt: 'text', csv: 'csv',
  mmd: 'mermaid', gradle: 'gradle', sol: 'solidity',
};

const BY_BASENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  jenkinsfile: 'groovy',
  '.gitattributes': 'gitconfig',
  '.gitignore': 'gitconfig',
  '.gitmodules': 'gitconfig',
  '.editorconfig': 'ini',
};

const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'gemfile.lock', 'composer.lock', 'go.sum',
  'mix.lock', 'pubspec.lock', 'podfile.lock', 'flake.lock', 'packages.lock.json', 'gradle.lockfile',
]);

export const LOCKFILE_LANGUAGE = 'lockfile';

export function isLockfile(filePath: string): boolean {
  const base = (filePath.split('/').pop() ?? '').toLowerCase();
  return LOCKFILE_NAMES.has(base);
}

/** Language for a repository-relative path, or null when unknown. Lockfiles are flagged `lockfile` (they stay in the inventory). */
export function languageForPath(filePath: string): string | null {
  const base = (filePath.split('/').pop() ?? '').toLowerCase();
  if (LOCKFILE_NAMES.has(base)) return LOCKFILE_LANGUAGE;
  const byName = BY_BASENAME[base];
  if (byName) return byName;
  if (base.startsWith('dockerfile.')) return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  // ".env" style names (dot at 0) use the part after the dot as the extension.
  return BY_EXTENSION[base.slice(dot + 1)] ?? null;
}
