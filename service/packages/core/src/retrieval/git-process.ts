/**
 * Hardened `git` child-process helpers shared by the generic provider and the exporter.
 * Never uses a shell; the environment is built from scratch (SS00 §5.3 credential separation).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthorizationError, RetrievalError, redactSecret } from './errors.js';

/** Config applied to every git invocation (ADR-010). `protocol.file.allow` is added only for tests. */
export function hardeningArgs(opts: { allowFileProtocol?: boolean } = {}): string[] {
  const cfg = [
    'core.hooksPath=/dev/null',
    'core.symlinks=false',
    'core.fsmonitor=false',
    'core.sshCommand=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'transfer.fsckObjects=true',
    'gc.auto=0',
  ];
  if (opts.allowFileProtocol) cfg.push('protocol.file.allow=always');
  return cfg.flatMap((c) => ['-c', c]);
}

/**
 * `file://` repositories exist only so tests can use local fixtures. The option is refused
 * unless NODE_ENV is exactly "test", so production configuration can never enable it.
 */
export function assertFileUrlAllowed(allowFileUrlForTests: boolean | undefined): boolean {
  if (!allowFileUrlForTests) return false;
  if (process.env.NODE_ENV !== 'test') {
    throw new RetrievalError('allowFileUrlForTests is only honoured when NODE_ENV is "test"', { code: 'file_url_refused' });
  }
  return true;
}

/** Printable ASCII without whitespace: keeps tokens out of header/config/shell injection territory. */
export function assertTokenShape(token: string): void {
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) {
    throw new AuthorizationError('repository token contains unsupported characters');
  }
}

export interface ScratchDir {
  dir: string;
  home: string;
  cleanup: () => Promise<void>;
}

/** Private scratch area (0700) holding HOME, credential helper files and (for the exporter) the bare repo. */
export async function makeScratch(prefix: string): Promise<ScratchDir> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await chmod(dir, 0o700);
  const home = path.join(dir, 'home');
  await mkdir(home, { mode: 0o700 });
  return { dir, home, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface GitEnvOptions {
  home: string;
  /** GIT_CONFIG_GLOBAL target; /dev/null when there is no credential */
  configGlobal?: string;
  askPass?: string;
}

export function gitEnv(o: GitEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: o.home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: o.configGlobal ?? '/dev/null',
    LC_ALL: 'C',
  };
  if (o.askPass) env.GIT_ASKPASS = o.askPass;
  return env;
}

export interface GitExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface GitProcess {
  child: ChildProcess;
  /** bounded copy of stderr */
  stderr: () => string;
  exit: Promise<GitExit>;
  kill: () => void;
}

export interface SpawnGitOptions {
  gitBin?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

const MAX_STDERR = 64 * 1024;

export function spawnGit(o: SpawnGitOptions): GitProcess {
  // detached => own process group, so a timeout can kill git and its helpers (git-remote-https, upload-pack...)
  const child = spawn(o.gitBin ?? 'git', o.args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => {
    if (stderr.length < MAX_STDERR) stderr += d.slice(0, MAX_STDERR - stderr.length);
  });
  let timedOut = false;
  let aborted = false;
  const kill = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, Math.max(1, o.timeoutMs));
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  if (o.signal) {
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
  }
  const exit = new Promise<GitExit>((resolve) => {
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, timedOut, aborted });
    };
    child.once('error', (err) => {
      stderr += `spawn error: ${err.message}`;
      done(null, null);
    });
    child.once('close', done);
  });
  return { child, stderr: () => stderr, exit, kill };
}

/** Run to completion, returning bounded stdout. */
export async function runGit(o: SpawnGitOptions & { maxStdoutBytes?: number }): Promise<{ stdout: string; stderr: string; exit: GitExit }> {
  const proc = spawnGit(o);
  const max = o.maxStdoutBytes ?? 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  proc.child.stdout?.on('data', (c: Buffer) => {
    size += c.length;
    if (size > max) proc.kill();
    else chunks.push(c);
  });
  const exit = await proc.exit;
  return { stdout: Buffer.concat(chunks).toString('utf8'), stderr: proc.stderr(), exit };
}

/**
 * Turn a failed git run into the error taxonomy. Output is truncated and the token (if any) redacted.
 * Unrecognised failures are NOT retryable: retrying an unexplained failure just burns the attempt budget.
 */
export function classifyGitFailure(what: string, exit: GitExit, stderr: string, token?: string): RetrievalError {
  const text = redactSecret(stderr, token).replace(/\s+/g, ' ').trim().slice(0, 400);
  if (exit.aborted) return new RetrievalError(`${what} cancelled`, { code: 'cancelled', retryable: false });
  if (exit.timedOut) return new RetrievalError(`${what} timed out`, { code: 'timeout', retryable: true });
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|http (401|403)|returned error: (401|403)|repository .{0,200}not found|access denied|permission denied/i.test(stderr)) {
    return new AuthorizationError(`${what}: repository not accessible with the supplied credentials`);
  }
  if (/could not resolve host|timed out|connection (reset|refused|timed out)|unable to access|early eof|rpc failed|returned error: 5\d\d|http 5\d\d|temporarily unavailable|tls|ssl/i.test(stderr)) {
    return new RetrievalError(`${what} failed (network): ${text}`, { code: 'network', retryable: true });
  }
  return new RetrievalError(`${what} failed: ${text || `exit ${exit.code ?? exit.signal ?? 'unknown'}`}`);
}

/** Write a GIT_ASKPASS helper (owner-only, executable because git must exec it). Content embeds the token, so it lives only in the 0700 scratch dir. */
export async function writeAskPass(scratchDir: string, token: string): Promise<string> {
  assertTokenShape(token);
  const quoted = `'${token.replace(/'/g, `'\\''`)}'`;
  const script = `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' ${quoted} ;;\nesac\n`;
  const file = path.join(scratchDir, 'askpass.sh');
  await writeFile(file, script, { mode: 0o700, flag: 'wx' });
  await chmod(file, 0o700);
  return file;
}
