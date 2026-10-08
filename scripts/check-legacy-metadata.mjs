#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(ROOT, 'tests', 'legacy-metadata');
const scriptPath = join(ROOT, 'scripts', 'prepare-metadata.sh');

if (process.platform === 'win32') {
  console.log('legacy metadata compatibility fixture: deferred to Linux CI (Windows shell bridge skipped)');
  process.exit(0);
}

function makeTree() {
  const tree = mkdtempSync(join(tmpdir(), 'weig-legacy-metadata-'));
  cpSync(fixture, tree, { recursive: true });
  copyFileSync(scriptPath, join(tree, 'prepare-metadata.sh'));
  copyFileSync(join(ROOT, 'scripts', 'native-installation-metadata.mjs'), join(tree, 'native-installation-metadata.mjs'));
  return tree;
}

const metadataTree = makeTree();
try {
  const invalid = spawnSync('bash', ['./prepare-metadata.sh', 'firmware-build'], {
    cwd: metadataTree, encoding: 'utf8',
  });
  if (invalid.status !== 2 ||
      !`${invalid.stdout}\n${invalid.stderr}`.includes('Unsupported metadata mode')) {
    throw new Error('unsupported metadata mode was not rejected');
  }
  const metadata = spawnSync('bash', ['./prepare-metadata.sh', 'metadata-only'], {
    cwd: metadataTree, encoding: 'utf8',
  });
  if (metadata.status !== 0 ||
      !existsSync(join(metadataTree, 'staging_dir', 'host', '.prereq-build')) ||
      !existsSync(join(metadataTree, 'tmp', '.targetinfo')) ||
      !existsSync(join(metadataTree, 'tmp', '.packageinfo')) ||
      !readFileSync(join(metadataTree, 'tmp', '.targetinfo'), 'utf8').includes('fixture')) {
    throw new Error(`metadata-only boundary failed:\n${metadata.stdout}\n${metadata.stderr}`);
  }
  console.log('metadata-only boundary checks passed: invalid=rejected metadata=generated');
} finally {
  rmSync(metadataTree, { recursive: true, force: true });
}
