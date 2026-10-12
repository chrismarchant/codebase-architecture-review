/**
 * Error taxonomy for stages 1-2 (authorize, retrieve). `retryable` tells the job
 * runner whether a fresh attempt could succeed (network, 5xx, rate limit) or
 * whether the request itself is wrong (no access, unknown ref, policy refusal).
 */
export class RetrievalError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, opts: { code?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code ?? 'retrieval_failed';
    this.retryable = opts.retryable ?? false;
  }
}

/** Credentials missing/insufficient, or the repository does not exist for this principal (GitHub returns 404 for both). */
export class AuthorizationError extends RetrievalError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, { code: 'repository_not_authorized', retryable: false, ...opts });
  }
}

/** The ref resolved to a different commit than the client-supplied SHA. */
export class ShaMismatch extends RetrievalError {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`resolved commit ${actual} does not match requested sha ${expected}`, { code: 'sha_mismatch', retryable: false });
    this.expected = expected;
    this.actual = actual;
  }
}

/** The URL was refused by the allow-list / SSRF policy. Never retryable. */
export class UrlPolicyError extends RetrievalError {
  constructor(message: string) {
    super(message, { code: 'url_rejected', retryable: false });
  }
}

/** Replace every occurrence of a secret in a string (messages must never carry tokens). */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}
