#!/usr/bin/env node
/**
 * Copy one stored object between two R2 buckets, for files too large for the
 * API's buffered migration limit.
 *
 * Why a script: `POST /api/admin/storage/migrate` copies through the Worker. Targets
 * that need a single signed PUT are bounded by `storageMigrationMaxBytes` (25 MiB
 * by default) because a streamed SigV4 PUT would require buffering the whole file in
 * Worker memory. This script moves the bytes outside the Worker with the wrangler CLI,
 * verifies the SHA-256 on both sides, and then tells you which API call to run.
 *
 * Usage:
 *   node scripts/storage-copy.mjs \
 *     --from aether-music --to aether-music-2 \
 *     --key audio/trk_…/abc12345/neon-rain.flac \
 *     [--content-type audio/flac] [--delete-source] [--local]
 *
 * Requirements: an authenticated wrangler session (`npx wrangler login`) with access to
 * both buckets. No secrets are read from or written to this script.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const from = flags.get('from');
const to = flags.get('to');
const key = flags.get('key');
const contentType = flags.get('content-type');
const deleteSource = flags.get('delete-source') === true;
const local = flags.get('local') === true;

if (typeof from !== 'string' || typeof to !== 'string' || typeof key !== 'string') {
  console.error('Usage: node scripts/storage-copy.mjs --from <bucket> --to <bucket> --key <object-key> [options]');
  process.exit(2);
}
if (from === to) {
  console.error('--from and --to must be different buckets.');
  process.exit(2);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

function wrangler(args) {
  return run('npx', ['wrangler', ...args, ...(local ? ['--local'] : ['--remote'])]);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

async function main() {
  const workDir = await mkdtemp(join(tmpdir(), 'aether-copy-'));
  const destination = join(workDir, basename(key) || 'object.bin');

  try {
    console.log(`Downloading s3://${from}/${key} …`);
    await wrangler(['r2', 'object', 'get', `${from}/${key}`, '--file', destination]);

    const info = await stat(destination);
    const sourceHash = await sha256File(destination);
    console.log(`  ${info.size} bytes · sha256 ${sourceHash}`);

    console.log(`Uploading s3://${to}/${key} …`);
    await wrangler([
      'r2',
      'object',
      'put',
      `${to}/${key}`,
      '--file',
      destination,
      ...(typeof contentType === 'string' ? ['--content-type', contentType] : []),
    ]);

    // Verify by downloading what was written.
    const verifyPath = join(workDir, 'verify.bin');
    await wrangler(['r2', 'object', 'get', `${to}/${key}`, '--file', verifyPath]);
    const destinationHash = await sha256File(verifyPath);

    if (destinationHash !== sourceHash) {
      console.error(`\n✗ Hash mismatch after copy.\n  source:      ${sourceHash}\n  destination: ${destinationHash}`);
      console.error('The destination object is NOT safe to use. Delete it and retry.');
      process.exit(1);
    }
    console.log(`Verified copy: sha256 ${destinationHash}`);

    if (deleteSource) {
      console.log(`Deleting s3://${from}/${key} …`);
      await wrangler(['r2', 'object', 'delete', `${from}/${key}`]);
      console.log('Source object deleted.');
    }

    console.log(`
Next steps:
  1. Register the destination bucket as a provider (if it is not one yet):
       POST /api/admin/storage/providers
  2. Verify the object through the API so the database records a fresh hash:
       POST /api/admin/storage/verify {"trackId":"<trk_…>"}
  3. Point the track at the new copy:
       POST /api/admin/storage/migrate {"trackId":"<trk_…>","targetProviderId":"<prv_…>","deleteSource":${deleteSource}}

The migrate call will copy again if the object is still owned by the old provider; if the
API reports "already stored on the requested provider", the pointer was flipped by this copy
plus a manual verification and no further action is needed.
`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Copy failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
