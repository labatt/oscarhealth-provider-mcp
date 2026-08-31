import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  MCP_PUBLIC_URL: 'https://mcp.example.com',
  MCP_PORT: '3070',
  MCP_LOGIN_USER: 'operator',
  MCP_LOGIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abc$def'
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => { saved = { ...process.env }; Object.assign(process.env, REQUIRED); });
afterEach(() => { process.env = saved; });

describe('loadConfig', () => {
  it('loads required values and defaults the Oscar base URL', () => {
    const c = loadConfig();
    expect(c.port).toBe(3070);
    expect(c.oscarBaseUrl).toBe('https://www.hioscar.com');
  });

  it('rejects a public URL with a trailing slash', () => {
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com/';
    expect(() => loadConfig()).toThrow(/trailing slash/);
  });

  it('rejects a non-numeric port', () => {
    process.env.MCP_PORT = 'abc';
    expect(() => loadConfig()).toThrow(/Invalid MCP_PORT/);
  });

  it('names the missing variable', () => {
    delete process.env.MCP_LOGIN_PASSWORD_HASH;
    expect(() => loadConfig()).toThrow(/MCP_LOGIN_PASSWORD_HASH/);
  });

  it('falls back to the default when OSCAR_BASE_URL is present but blank', () => {
    // `cp .env.example .env` used to yield an empty base URL, because `??`
    // only falls back on null/undefined and a blank key is an empty string.
    process.env.OSCAR_BASE_URL = '';
    expect(loadConfig().oscarBaseUrl).toBe('https://www.hioscar.com');
  });

  it('falls back when OSCAR_BASE_URL is only whitespace', () => {
    process.env.OSCAR_BASE_URL = '   ';
    expect(loadConfig().oscarBaseUrl).toBe('https://www.hioscar.com');
  });

  it('still honours a real OSCAR_BASE_URL override', () => {
    process.env.OSCAR_BASE_URL = 'https://staging.example';
    expect(loadConfig().oscarBaseUrl).toBe('https://staging.example');
  });
});
