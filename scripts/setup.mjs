#!/usr/bin/env node
/**
 * Interactive setup.
 *
 * Everything opaque is discovered rather than asked for. The user picks their
 * state, then their network and plan BY NAME from Oscar Health's own catalogue; the
 * policyId, formulary tier and a sensible default ZIP fall out of that. The
 * only thing a person should have to recognise is the plan name printed on
 * their insurance card.
 *
 * Writes config/plans.json and .env. Never overwrites either without asking.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.OSCAR_BASE_URL?.trim() || 'https://www.hioscar.com';
const UA = 'oscarhealth-provider-mcp setup (https://github.com/labatt/oscarhealth-provider-mcp)';

/**
 * Prompt layer that works both interactively and with piped input.
 *
 * A plain readline interface is not enough: this script makes network calls
 * before its first question, and on a pipe readline reaches EOF during those
 * calls and closes, so every later question rejects with "readline was closed".
 * When stdin is not a TTY we therefore drain it up front and answer from that
 * buffer, which also makes the script scriptable and testable.
 */
const interactive = Boolean(stdin.isTTY);
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
let piped = null;

async function drainStdin() {
  if (piped) return piped;
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return piped;
}

async function prompt(question) {
  if (interactive) return rl.question(question);
  const lines = await drainStdin();
  const next = lines.length > 0 ? lines.shift() : '';
  stdout.write(`${question}${next}\n`);
  return next;
}
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

async function get(path, params = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${url.pathname} returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`${url.pathname} failed (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 160)}`);
  return body;
}

/** Numbered picker. Returns the chosen item. */
async function choose(label, items, render) {
  if (items.length === 0) throw new Error(`Nothing to choose for ${label}.`);
  if (items.length === 1) {
    console.log(`\n${b(label)}\n  Only one option: ${render(items[0])}`);
    return items[0];
  }
  console.log(`\n${b(label)}`);
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. ${render(it)}`));
  for (;;) {
    const a = (await prompt(`  Choose 1-${items.length}: `)).trim();
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    if (!interactive && a === '') throw new Error(`No answer supplied for "${label}".`);
    console.log(yellow('  Enter one of the numbers above.'));
  }
}

async function ask(q, fallback) {
  const a = (await prompt(fallback ? `${q} ${dim(`[${fallback}]`)}: ` : `${q}: `)).trim();
  return a || fallback || '';
}

async function confirm(q) {
  const a = (await prompt(`${q} ${dim('[y/N]')}: `)).trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

async function main() {
  console.log(`\n${b('Oscar Health Provider MCP — setup')}`);
  console.log(dim('Discovers your plan from Oscar Health\'s own catalogue, then writes config/plans.json and .env.\n'));

  // ---- 1. Plan discovery -------------------------------------------------
  console.log(dim(`Fetching the network catalogue from ${BASE} …`));
  const catalogue = await get('/search/api/v2/networks');
  const byYear = catalogue.networkDetailsByYear ?? {};
  const years = Object.keys(byYear).sort();
  if (years.length === 0) throw new Error('The network catalogue came back empty.');

  const year = Number(await choose('Plan year', years, (y) => y));
  const networks = byYear[String(year)] ?? {};

  const statesFor = (net) =>
    [...new Set(Object.values(net.coverageAreas ?? {}).map((c) => c.state).filter(Boolean))];
  const allStates = [...new Set(Object.values(networks).flatMap(statesFor))].sort();
  const state = await choose('State', allStates, (s) => s);

  const inState = Object.entries(networks)
    .filter(([, net]) => statesFor(net).includes(state))
    .sort((a, b2) => a[1].name.localeCompare(b2[1].name));
  const [networkId, network] = await choose(
    `Network in ${state} for ${year}`,
    inState,
    ([id, net]) => `${net.name}  ${dim(`(${id}, ${net.networkType ?? 'network'})`)}`
  );

  console.log(dim('\nFetching the plans on that network …'));
  let policyId = '';
  let formularyPlanType = 'INDIVIDUAL_4_TIER';
  try {
    const planData = await get('/api/get-network-plans', { networkId, planYear: year, state });
    const options = (planData.plans ?? []).flatMap((g) => g.options ?? []);
    if (options.length > 0) {
      const chosen = await choose(
        'Your plan (as printed on your insurance card)',
        options,
        ([, name, tier]) => `${name}  ${dim(tier)}`
      );
      [policyId, , formularyPlanType] = chosen;
    }
  } catch (e) {
    console.log(yellow(`  Could not list plans: ${e.message}`));
  }
  if (!policyId) {
    console.log(dim('  Falling back to manual entry. Your policyId appears in the URL when you'));
    console.log(dim('  use Oscar Health\'s own Find Care page, as policyId=…'));
    policyId = await ask('  policyId', '00000000-0000-0000-0000-000000000000');
  }

  const anchorZip = Object.values(network.coverageAreas ?? {})[0]?.searchAnchor?.zipCode;
  const zipCode = await ask('\nZIP code to anchor searches on', anchorZip ?? '');

  // ---- 2. Verify against the live API before writing anything ------------
  console.log(dim('\nVerifying with a real search …'));
  let verified = false;
  try {
    const r = await get('/member/search/results/doctors/api', {
      specialty: 'CLINPCPMAN', network_id: networkId, state, year,
      zip_code: zipCode, include_no_new_patients: true, sort: 1, page: 0
    });
    const n = r.totalResultCount ?? 0;
    if (n > 0) {
      console.log(green(`  ✓ ${n.toLocaleString()} primary care providers found near ${zipCode}.`));
      verified = true;
    } else {
      console.log(yellow('  No providers returned. The ZIP may be outside this network\'s coverage area.'));
    }
  } catch (e) {
    console.log(yellow(`  Verification request failed: ${e.message}`));
  }
  if (!verified && !(await confirm('  Continue anyway?'))) {
    console.log('Aborted; nothing written.');
    return;
  }

  // ---- 3. Write config/plans.json ----------------------------------------
  const planId = `${state.toLowerCase()}-${year}`;
  const plans = {
    defaultPlan: planId,
    plans: { [planId]: { label: `${year} ${network.name}`, year, state, networkId, policyId, zipCode, formularyPlanType } }
  };
  const plansPath = join(ROOT, 'config', 'plans.json');
  if (existsSync(plansPath) && !(await confirm(`\n${plansPath} exists. Overwrite?`))) {
    console.log(dim('  Kept the existing file.'));
  } else {
    mkdirSync(join(ROOT, 'config'), { recursive: true });
    writeFileSync(plansPath, JSON.stringify(plans, null, 2) + '\n');
    console.log(green(`\n  ✓ wrote config/plans.json  (${plans.plans[planId].label})`));
  }

  // ---- 4. Write .env ------------------------------------------------------
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath) && !(await confirm(`${envPath} exists. Overwrite?`))) {
    console.log(dim('  Kept the existing .env. Setup complete.'));
    return;
  }

  console.log(`\n${b('Server settings')}`);
  const publicUrl = (await ask('Public URL of this server (OAuth issuer, no trailing slash)', 'https://mcp.example.com'))
    .replace(/\/+$/, '');
  const port = await ask('Loopback port', '3070');
  const loginUser = await ask('Operator username', 'operator');

  let password = await ask('Operator password (blank to generate a strong one)', '');
  let generated = false;
  if (!password) { password = randomBytes(18).toString('base64url'); generated = true; }

  console.log(dim('\nHashing the password …'));
  const argon2 = (await import('argon2')).default;
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const sessionSecret = randomBytes(32).toString('hex');

  const env = [
    `MCP_PUBLIC_URL=${publicUrl}`,
    `MCP_PORT=${port}`,
    `MCP_LOGIN_USER=${loginUser}`,
    `MCP_LOGIN_PASSWORD_HASH=${hash}`,
    `MCP_SESSION_SECRET=${sessionSecret}`,
    '',
    '# Optional. Defaults to https://www.hioscar.com. Leave commented out — a key',
    '# present but EMPTY is an empty string, not "unset", and would blank the URL.',
    '# OSCAR_BASE_URL=https://www.hioscar.com',
    '',
    '# Set this to your MCP client\'s callback host once you have connected it,',
    '# e.g. claude.ai, then restart. Until then any party can register a client.',
    'MCP_ALLOWED_REDIRECT_HOSTS=',
    ''
  ].join('\n');
  writeFileSync(envPath, env);
  try { chmodSync(envPath, 0o600); } catch { /* best effort on non-POSIX */ }
  console.log(green('  ✓ wrote .env (mode 600)'));

  console.log(`\n${b('Done.')}`);
  if (generated) {
    console.log(`\n  ${b('Your operator password — save it now, it is not stored anywhere:')}`);
    console.log(`      ${b(password)}\n`);
  }
  console.log('  Next:');
  console.log('    npm run build && node dist/server.js');
  console.log(`    then add ${publicUrl}/mcp as a custom MCP connector`);
  console.log(dim('\n  After connecting, set MCP_ALLOWED_REDIRECT_HOSTS in .env to your'));
  console.log(dim('  client\'s callback host and restart. See the README.\n'));
}

main()
  .catch((e) => { console.error(`\n\x1b[31mSetup failed:\x1b[0m ${e.message}`); process.exitCode = 1; })
  .finally(() => rl?.close());
