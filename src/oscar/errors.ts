export class OscarUpstreamError extends Error {
  readonly status: number;
  readonly requestId?: string;

  constructor(status: number, message: string, requestId?: string) {
    super(message);
    this.name = 'OscarUpstreamError';
    this.status = status;
    this.requestId = requestId;
  }

  /** Message shown to the model — actionable, and never leaks a stack trace. */
  toToolMessage(): string {
    const id = this.requestId ? ` (upstream request id ${this.requestId})` : '';
    if (this.status === 404) return `Oscar returned 404 — the specialty or provider id may be wrong${id}.`;
    if (this.status === 429) return `Oscar is rate-limiting this server. Wait before retrying${id}.`;
    if (this.status >= 500) return `Oscar's API is failing (HTTP ${this.status}). This is upstream, not a bad query${id}.`;
    return `Oscar rejected the request (HTTP ${this.status}): ${this.message}${id}`;
  }
}
