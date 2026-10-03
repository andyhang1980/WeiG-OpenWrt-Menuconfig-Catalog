#!/usr/bin/env node
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  fileURLToPath,
} from 'node:url';
import {
  fileContract,
  indexContract,
  stampIndex,
} from './index-contract.mjs';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

const script = join(
  ROOT,
  'scripts',
  'sync-index-assets.mjs',
);

const temp = mkdtempSync(
  join(
    tmpdir(),
    'weig-catalog-assets-',
  ),
);

const dist = join(temp, 'dist');
mkdirSync(dist);

try {
  const asset = 'demo--main.json.gz';
  const assetFile = join(dist, asset);
  const coreAsset = 'demo--main.core.json.gz';
  const graphAsset = 'demo--main.graph.json.gz';
  const coreFile = join(dist, coreAsset);
  const graphFile = join(dist, graphAsset);
  const compatibilityAsset = 'compatibility.json.gz';
  const compatibilityFile = join(dist, compatibilityAsset);

  writeFileSync(assetFile, Buffer.from('catalog-v1'));
  writeFileSync(coreFile, Buffer.from('core-v1'));
  writeFileSync(graphFile, Buffer.from('graph-v1'));
  writeFileSync(compatibilityFile, Buffer.from('compatibility-v1'));

  const staleIndex = stampIndex({
    schema: 2,
    generatedAt:
      '2026-01-01T00:00:00.000Z',
    commit: 'demo',
    assets: {
      compatibility: { asset: compatibilityAsset, hash: 'stale-compatibility', bytes: 1, schema: 1 },
    },
    health: {
      fresh: 1,
      stale: 0,
      unavailable: 0,
    },
    sources: [
      {
        id: 'Demo',
        label: 'Demo',
        repo: 'example/demo',
        branches: [
          {
            id: 'main',
            version: 'main',
            branch: 'main',
            asset,
            hash: 'stale-hash',
            bytes: 1,
            legacy: { asset, hash: 'stale-legacy', bytes: 2, catalogSchema: 5, relationsSchema: 2 },
            assets: {
              core: { asset: coreAsset, hash: 'stale-core', bytes: 1 },
              graph: { asset: graphAsset, hash: 'stale-graph', bytes: 1 },
            },
            state: 'fresh',
          },
        ],
      },
    ],
  });

  const indexFile = join(
    dist,
    'index.json',
  );

  writeFileSync(
    indexFile,
    JSON.stringify(
      staleIndex,
      null,
      2,
    ) + '\n',
  );

  execFileSync(
    process.execPath,
    [script, dist],
    { stdio: 'pipe' },
  );

  const fixed = JSON.parse(
    readFileSync(indexFile, 'utf8'),
  );

  const branch =
    fixed.sources[0].branches[0];

  const actual =
    fileContract(assetFile);

  const actualCore = fileContract(coreFile);
  const actualGraph = fileContract(graphFile);
  const actualCompatibility = fileContract(compatibilityFile);
  if (branch.hash !== actual.hash || branch.bytes !== actual.bytes ||
      branch.legacy?.asset !== asset || branch.legacy?.hash !== actual.hash ||
      branch.legacy?.bytes !== actual.bytes || branch.legacy?.catalogSchema !== 5 ||
      branch.legacy?.relationsSchema !== 2 || branch.assets.core.hash !== actualCore.hash || branch.assets.core.bytes !== actualCore.bytes ||
      branch.assets.graph.hash !== actualGraph.hash || branch.assets.graph.bytes !== actualGraph.bytes ||
      fixed.assets.compatibility.hash !== actualCompatibility.hash ||
      fixed.assets.compatibility.bytes !== actualCompatibility.bytes) {
    throw new Error('legacy/split asset metadata synchronization failed');
  }

  const root = indexContract(fixed);

  if (
    fixed.hash !== root.hash ||
    fixed.bytes !== root.bytes
  ) {
    throw new Error(
      'index root contract ' +
      'synchronization failed',
    );
  }

  const once =
    readFileSync(indexFile);

  execFileSync(
    process.execPath,
    [script, dist],
    { stdio: 'pipe' },
  );

  const twice =
    readFileSync(indexFile);

  if (!once.equals(twice)) {
    throw new Error(
      'asset synchronization ' +
      'is not idempotent',
    );
  }

  execFileSync(
    process.execPath,
    [script, dist, '--check'],
    { stdio: 'pipe' },
  );

  // Execute the real fast-path publisher selector against both public wire
  // generations. A green publish must not stage only the legacy projection.
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'catalog.yml'), 'utf8');
  const selector = workflow.match(/node --input-type=module - previous <<'NODE' > "\$RUNNER_TEMP\/catalog-root-assets\.paths"\n([\s\S]*?)\n\s+NODE/);
  if (!selector) throw new Error('root-asset publisher lacks a contract-driven file selector');
  const modernAsset = 'compatibility.v6.json.gz';
  const modernFile = join(dist, modernAsset);
  const modernBytes = Buffer.from('compatibility-modern-v1');
  writeFileSync(modernFile, modernBytes);
  fixed.assets.compatibilityV6 = { asset: modernAsset, ...fileContract(modernFile), schema: 6 };
  const saveRootIndex = () => writeFileSync(indexFile, JSON.stringify(stampIndex(fixed)) + '\n');
  saveRootIndex();
  const selectRootAssets = (families = 'compatibility') => spawnSync(process.execPath,
    ['--input-type=module', '-', dist], { cwd: ROOT, input: selector[1], encoding: 'utf8',
      env: { ...process.env, FAST_ASSETS: families } });
  const selected = selectRootAssets();
  if (selected.status !== 0 || selected.stdout.trim().split(/\r?\n/).join(',') !==
      [compatibilityAsset, modernAsset].sort().join(',')) {
    throw new Error(`versioned root publication selector failed: ${selected.stderr || selected.stdout}`);
  }
  writeFileSync(modernFile, Buffer.from('stale-modern-content'));
  const staleModern = selectRootAssets();
  if (staleModern.status === 0 || !staleModern.stderr.includes('contract mismatch')) {
    throw new Error('root publisher accepted a stale modern asset');
  }
  rmSync(modernFile);
  if (selectRootAssets().status === 0) throw new Error('root publisher accepted a missing modern asset');
  writeFileSync(modernFile, modernBytes);
  if (selectRootAssets('missing-family').status === 0) throw new Error('root publisher accepted a missing asset family');
  const savedAsset = fixed.assets.compatibilityV6.asset;
  fixed.assets.compatibilityV6.asset = 'compatibility../unsafe.json.gz';
  saveRootIndex();
  if (selectRootAssets().status === 0) throw new Error('root publisher accepted an unsafe asset path');
  fixed.assets.compatibilityV6.asset = savedAsset;
  saveRootIndex();

  writeFileSync(graphFile, Buffer.from('graph-v2'));

  const failed = spawnSync(
    process.execPath,
    [script, dist, '--check'],
    { encoding: 'utf8' },
  );

  if (
    failed.status === 0 ||
    !failed.stderr.includes(
      'asset mismatch',
    )
  ) {
    throw new Error(
      'check mode did not reject ' +
      'a modified asset',
    );
  }

  console.log(
    'catalog asset index checks passed: ' +
    'legacy/split update, root contract, ' +
    'idempotence, versioned root publication, missing/stale/unsafe rejection and shard tamper rejection',
  );
} finally {
  rmSync(
    temp,
    {
      recursive: true,
      force: true,
    },
  );
}
