#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeCompactRelationTables } from './relation-table-codec.mjs';
import { captureCatalogInputs, catalogInputsHash } from './catalog-inputs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = mkdtempSync(join(tmpdir(), 'weig-branch-assets-'));
const fixture = join(ROOT, 'tests', 'fixture');
const tree = join(output, 'tree');

try {
  mkdirSync(join(tree, 'tmp'), { recursive: true });
  writeFileSync(join(tree, 'Config.in'), readFileSync(join(fixture, 'Config.in'), 'utf8') +
    '\nconfig PACKAGE_luci-app-demo_INCLUDE_payload\n\tbool "Optional data"\n' +
    '\nconfig PACKAGE_luci-app-symbol-only\n\ttristate "Not an installable package"\n');
  copyFileSync(join(fixture, 'targetinfo'), join(tree, 'tmp', '.targetinfo'));
  copyFileSync(join(fixture, 'packageinfo'), join(tree, 'tmp', '.packageinfo'));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const initialize = directory => {
    git(directory, 'init');
    git(directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture inputs');
  };
  initialize(tree);
  const feedTree = join(tree, 'feeds', 'packages');
  mkdirSync(feedTree, { recursive: true });
  initialize(feedTree);
  const feedCommit = git(feedTree, 'rev-parse', 'HEAD');
  writeFileSync(join(tree, 'feeds.conf'), 'src-git --force packages https://example.invalid/packages.git;stable\n');
  const receipt = { outcome: 'success', feeds: [{ name: 'packages', status: 'success', commit: feedCommit }] };
  const receiptPath = join(output, 'feeds-runtime.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const inputs = captureCatalogInputs(tree, receipt);
  assert.equal(inputs.feeds[0].url, 'https://example.invalid/packages.git');
  assert.deepEqual(inputs.feeds[0].options, ['--force']);
  assert.throws(() => captureCatalogInputs(tree, { ...receipt, outcome: 'failure' }), /receipt/);
  assert.throws(() => captureCatalogInputs(tree, { ...receipt, feeds: [] }), /receipt/);
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'generate-catalog.mjs'),
    '--source-id', 'Fixture',
    '--label', 'Fixture',
    '--repo', 'example/fixture',
    '--branch', 'test',
    '--legacy', 'false',
    '--tree', tree,
    '--feeds-runtime', receiptPath,
    '--size-sample', join(fixture, 'package-size-sample.json'),
    '--out', output,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const readGzipJson = (name) => JSON.parse(gunzipSync(readFileSync(join(output, name))).toString('utf8'));
  const core = readGzipJson('fixture--test.core.json.gz');
  const sizes = readGzipJson('fixture--test.package-sizes.json.gz');
  const meta = JSON.parse(readFileSync(join(output, 'fixture--test.meta.json'), 'utf8'));
  const legacyGraph = readGzipJson('fixture--test.graph.json.gz');
  assert.deepEqual(meta.buildInputs, inputs);
  assert.equal(core.source.inputsHash, catalogInputsHash(inputs));
  assert.equal(legacyGraph.source.inputsHash, core.source.inputsHash);
  const compactGraph = readGzipJson('fixture--test.graph.compact.json.gz');
  assert.deepEqual(decodeCompactRelationTables(compactGraph.relations), legacyGraph.relations);
  assert.equal(meta.assets.graphCompact.asset, 'fixture--test.graph.compact.json.gz');
  assert.equal(compactGraph.source.commit, legacyGraph.source.commit);

  assert.deepEqual(core.applications.fields, ['symbol', 'package', 'group', 'hot']);
  assert(core.applications.rows.some((row) => row[0] === 'PACKAGE_luci-app-demo' && row[1] === 'luci-app-demo'));
  assert(!core.applications.rows.some((row) => /INCLUDE_payload|symbol-only/.test(row[0])),
    'Kconfig suboptions must not become application packages');
  assert(!sizes.rows.some((row) => /INCLUDE_payload|symbol-only/.test(row[0])));
  assert.equal(core.applications.rows.some((row) => row[1] === 'luci-app-packageinfo-only'), false,
    'packageinfo-only metadata must not become a selectable branch application');
  assert.deepEqual(sizes.fields, ['package', 'archiveBytes', 'installedBytes']);
  assert.deepEqual(sizes.rows.find((row) => row[0] === 'luci-app-demo'), ['luci-app-demo', 100, 240]);
  assert.equal(sizes.observation.match, 'exact-source-branch-architecture-package-version');
  assert.equal(sizes.coverage.total >= sizes.coverage.known, true);
  assert.equal(meta.assets.packageSizes.asset, 'fixture--test.package-sizes.json.gz');
  assert.equal(meta.assets.packageSizes.items, sizes.rows.length);
  assert.equal(meta.assets.packageSizes.totalPackages, sizes.coverage.total);
  assert.equal(meta.assets['packageSizes:x86_64'].installedItems, sizes.rows.filter(row => row[2] != null).length);

  // Multiple official architectures retain independent, version-matched size
  // observations; neither newer binaries nor another Source/Branch may leak in.
  const sample = JSON.parse(readFileSync(join(fixture, 'package-size-sample.json'), 'utf8'));
  const observations = [
    { ...sample, architecture: 'arch_a' },
    { ...sample, architecture: 'arch_b', packages: sample.packages.map(row => ({ ...row, size: row.size * 2, installedSize: row.installedSize * 2 })) },
    { ...sample, architecture: 'arch_new', packages: sample.packages.map(row => ({ ...row, version: 'mismatched-version' })) },
    { ...sample, architecture: 'arch_other_source', source: 'Other' },
  ];
  const bundle = join(output, 'size-bundle.json');
  writeFileSync(bundle, JSON.stringify({ schema: 3, observations: observations.map((row, index) => {
    const file = `size-observation-${index}.json`;
    writeFileSync(join(output, file), JSON.stringify(row));
    return { architecture: row.architecture, file };
  }) }));
  execFileSync(process.execPath, [join(ROOT, 'scripts/generate-catalog.mjs'),
    '--source-id', 'Fixture', '--repo', 'example/fixture', '--branch', 'test', '--tree', tree,
    '--size-sample', bundle, '--out', output], { stdio: ['ignore', 'pipe', 'pipe'] });
  const multiMeta = JSON.parse(readFileSync(join(output, 'fixture--test.meta.json'), 'utf8'));
  const a = readGzipJson(multiMeta.assets['packageSizes:arch_a'].asset);
  const b = readGzipJson(multiMeta.assets['packageSizes:arch_b'].asset);
  assert.equal(b.rows[0][1], a.rows[0][1] * 2);
  assert.equal(b.rows[0][2], a.rows[0][2] * 2);
  assert.equal(multiMeta.assets['packageSizes:arch_new'].installedItems, 0);
  assert.equal(readGzipJson(multiMeta.assets['packageSizes:arch_new'].asset).rows.length, 0);
  assert.equal(multiMeta.assets['packageSizes:arch_other_source'], undefined);
  console.log(`Branch application/size assets passed: applications=${core.applications.rows.length} sizes=${sizes.rows.length}/${sizes.coverage.total}`);
} finally {
  rmSync(output, { recursive: true, force: true });
}
