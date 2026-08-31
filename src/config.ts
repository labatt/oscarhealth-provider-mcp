import 'dotenv/config';

export interface Config {
  publicUrl: string;
  port: number;
  oscarBaseUrl: string;
  loginUser: string;
  loginPasswordHash: string;
  sessionSecret: string;
  /** Optional hostname allowlist for OAuth redirect URIs. See the notes in this file. */
  allowedRedirectHosts?: string[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/**
 * Reads an optional variable, treating blank as absent. `??` alone is wrong
 * here: a key present-but-empty in .env (which is how .env.example ships
 * commented-out options) is an empty string, not undefined, so `?? default`
 * keeps the empty value. That produced an empty Oscar base URL on any machine
 * set up by copying .env.example — every upstream request failing at deploy
 * time, from a file that looked correctly filled in.
 */
function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function parsePort(): number {
  const raw = required('MCP_PORT');
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid MCP_PORT: "${raw}". Must be a positive integer.`);
  }
  return n;
}

/**
 * Comma-separated hostnames permitted as OAuth redirect targets.
 *
 * Unset or blank means NO client may be authorized — this fails closed. That
 * matters because dynamic client registration is open: anyone who finds the URL
 * can register a client called "Claude" pointing at their own callback and send
 * the operator an /authorize link. The operator then sees a genuine consent page
 * on their own domain and types their real password, and the code lands on the
 * attacker's host. The consent screen names the redirect host precisely so that
 * is noticeable, but noticing is a judgement call made under time pressure; a
 * closed default is not.
 *
 * The literal `*` is the explicit opt-out for anyone who wants the old
 * behaviour and has understood the trade-off.
 */
function parseAllowedRedirectHosts(): string[] | undefined {
  const hosts = (process.env.MCP_ALLOWED_REDIRECT_HOSTS ?? '')
    .split(',').map(h => h.trim().toLowerCase()).filter(h => h.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

export function loadConfig(): Config {
  const publicUrl = required('MCP_PUBLIC_URL');
  if (publicUrl.endsWith('/')) {
    throw new Error('MCP_PUBLIC_URL must not have a trailing slash — it is the OAuth issuer and must match exactly.');
  }
  return {
    publicUrl,
    port: parsePort(),
    oscarBaseUrl: optional('OSCAR_BASE_URL') ?? 'https://www.hioscar.com',
    loginUser: required('MCP_LOGIN_USER'),
    loginPasswordHash: required('MCP_LOGIN_PASSWORD_HASH'),
    sessionSecret: required('MCP_SESSION_SECRET'),
    allowedRedirectHosts: parseAllowedRedirectHosts()
  };
}
