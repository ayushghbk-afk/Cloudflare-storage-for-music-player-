#!/usr/bin/env node
/**
 * Environment readiness check.
 *
 * Reads `worker/.dev.vars` (local development) and `process.env` (CI / shell),
 * then reports which required settings are present, which are still placeholders
 * and which storage credential namespaces are incomplete.
 *
 * It NEVER prints a value — only presence, length class and the secret *name*.
 * Nothing here connects to Cloudflare, so it is safe to run in CI.
 *
 * Usage:
 *   node scripts/check-env.mjs            # report, exit 0 unless something is malformed
 *   node scripts/check-env.mjs --strict   # exit 1 when required values are missing
 */
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const devVarsPath = resolve(repoRoot, 'worker/.dev.vars');
const strict = process.argv.includes('--strict');

/** Values that look like a placeholder and must be replaced before deploying. */
const PLACEHOLDER_PATTERNS = [
  /^$/,
  /^changeme$/i,
  /^change-me$/i,
  /^replace[-_ ]?me$/i,
  /^your[-_ ]/i,
  /<[^>]+>/,
  /^xxx+$/i,
  /^todo$/i,
  /^test$/i,
];

const REQUIRED = [
  {
    name: 'JWT_SECRET',
    why: 'Signs access tokens. The Worker returns 503 for authenticated routes without it.',
    validate: (value) => (value.length >= 32 ? null : `must be at least 32 characters (received ${value.length})`),
  },
  {
    name: 'ALLOWED_ORIGINS',
    why: 'CORS allowlist. Without it the API answers * for every origin.',
    validate: (value) =>
      value.split(',').every((origin) => /^https?:\/\/[^\s]+$/.test(origin.trim())) ? null : 'must be a comma separated list of http(s) origins',
  },
];

const OPTIONAL = [
  { name: 'TURNSTILE_SECRET_KEY', why: 'Server-side Turnstile verification. Public registration is unprotected without it.' },
  { name: 'TURNSTILE_SITE_KEY', why: 'Published to the web client through GET /api/config.' },
  { name: 'BOOTSTRAP_ADMIN_EMAIL', why: 'Creates the first administrator once, while no admin exists.' },
  { name: 'R2_DEFAULT_REGION', why: 'Region used for new providers (default: auto).' },
  { name: 'STREAM_MODE', why: 'auto | proxy | redirect (default: auto).' },
];

const FORBIDDEN_IN_WRANGLER = ['JWT_SECRET', 'TURNSTILE_SECRET_KEY', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'];

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

async function readDevVars() {
  try {
    await access(devVarsPath);
  } catch {
    return null;
  }
  const text = await readFile(devVarsPath, 'utf8');
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function lookup(name, devVars) {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, source: 'environment' };
  if (devVars && devVars.has(name)) return { value: devVars.get(name), source: 'worker/.dev.vars' };
  return null;
}

function credentialNamespaces(devVars) {
  const names = new Set();
  const scan = (key) => {
    const match = /^R2_([A-Z0-9_]+)_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/.exec(key);
    if (match) names.add(match[1]);
  };
  if (devVars) for (const key of devVars.keys()) scan(key);
  for (const key of Object.keys(process.env)) scan(key);

  return [...names].sort().map((ref) => {
    const accessKeyId = `R2_${ref}_ACCESS_KEY_ID`;
    const secretAccessKey = `R2_${ref}_SECRET_ACCESS_KEY`;
    return {
      ref,
      hasAccessKeyId: Boolean(lookup(accessKeyId, devVars)),
      hasSecretAccessKey: Boolean(lookup(secretAccessKey, devVars)),
      names: [accessKeyId, secretAccessKey],
    };
  });
}

async function wranglerLeaks() {
  const path = resolve(repoRoot, 'worker/wrangler.toml');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return ['worker/wrangler.toml is missing.'];
  }
  const problems = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    for (const key of FORBIDDEN_IN_WRANGLER) {
      if (line.startsWith(key)) {
        problems.push(`worker/wrangler.toml defines ${key}. Secrets belong in \`wrangler secret put\`, never in the repository.`);
      }
    }
  }
  const databaseId = /database_id\s*=\s*"([^"]*)"/.exec(text)?.[1];
  if (!databaseId || /^0+(-0+){4}$/.test(databaseId)) {
    problems.push('worker/wrangler.toml still has the placeholder database_id. Run `npx wrangler d1 create aether-db` and paste the id in.');
  }
  const kvId = /\[\[kv_namespaces\]\][\s\S]*?\bid\s*=\s*"([^"]*)"/.exec(text)?.[1];
  if (kvId !== undefined && /^0+$/.test(kvId)) {
    problems.push('worker/wrangler.toml still has the placeholder KV namespace id. Run `npx wrangler kv namespace create MUSIC_CACHE`.');
  }
  return problems;
}

async function main() {
  const devVars = await readDevVars();
  const problems = [];
  const warnings = [];
  const pending = [];

  console.log('AETHER environment readiness\n');
  console.log(`  Sources: process.env${devVars ? ' + worker/.dev.vars' : ' (worker/.dev.vars not found)'}`);
  console.log(`  Mode:    ${strict ? 'strict (fails on missing required values)' : 'report only'}\n`);

  for (const entry of REQUIRED) {
    const found = lookup(entry.name, devVars);
    if (!found || isPlaceholder(found.value)) {
      pending.push(`${entry.name} — ${entry.why}`);
      problems.push(`${entry.name} is missing or still a placeholder.`);
      console.log(`  ✗ ${entry.name.padEnd(24)} missing (${entry.why})`);
      continue;
    }
    const invalid = entry.validate?.(found.value);
    if (invalid) {
      problems.push(`${entry.name} ${invalid}.`);
      console.log(`  ✗ ${entry.name.padEnd(24)} invalid: ${invalid}`);
    } else {
      console.log(`  ✓ ${entry.name.padEnd(24)} set (${found.source}, ${found.value.length} chars)`);
    }
  }

  for (const entry of OPTIONAL) {
    const found = lookup(entry.name, devVars);
    if (!found || isPlaceholder(found.value)) {
      console.log(`  · ${entry.name.padEnd(24)} not set (${entry.why})`);
      continue;
    }
    console.log(`  ✓ ${entry.name.padEnd(24)} set (${found.source})`);
  }

  const namespaces = credentialNamespaces(devVars);
  console.log('');
  if (namespaces.length === 0) {
    console.log('  · No R2_<REF>_ACCESS_KEY_ID credential namespaces found.');
    console.log('    A provider registered with authMode "credentials" needs them before it can be used.');
  } else {
    console.log('  R2 credential namespaces:');
    for (const namespace of namespaces) {
      const complete = namespace.hasAccessKeyId && namespace.hasSecretAccessKey;
      console.log(`  ${complete ? '✓' : '✗'} ${namespace.ref.padEnd(20)} ${namespace.names.join(' + ')}`);
      if (!complete) problems.push(`Credential namespace ${namespace.ref} is incomplete; the provider will report "unconfigured".`);
    }
  }

  const configProblems = await wranglerLeaks();
  problems.push(...configProblems);

  console.log('');

  if (pending.length > 0) {
    console.log('Still to configure:');
    for (const item of pending) console.log(`  - ${item}`);
    console.log('');
  }

  if (problems.length > 0) {
    console.log('Problems:');
    for (const problem of problems) console.log(`  - ${problem}`);
  } else {
    console.log('No configuration problems detected.');
  }
  if (warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of warnings) console.log(`  - ${warning}`);
  }

  console.log('\nNext: docs/SETUP.md · docs/STORAGE.md · npm run db:migrate:local');

  const blocking = problems.filter((problem) => !problem.startsWith('Credential namespace'));
  if (strict && blocking.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Environment check crashed:', error);
  process.exit(1);
});
