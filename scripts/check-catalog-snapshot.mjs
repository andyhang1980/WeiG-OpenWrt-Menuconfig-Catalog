#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { indexContract, stampIndex } from './index-contract.mjs';

const TEST_REPOSITORY = process.env.GITHUB_REPOSITORY || 'weigefenxiang/WeiG-OpenWrt-Menuconfig-Catalog';
process.env.GITHUB_REPOSITORY = TEST_REPOSITORY;
import {
  stampCatalogSnapshot, verifyCatalogRuntimeSurface, verifyReusableCatalogSnapshot,
  prepareCatalogAssetManifest, verifyCatalogAssetManifest,
} from './stamp-catalog-snapshot.mjs';

const ref = '0123456789abcdef0123456789abcdef01234567';
const codeSha = '89abcdef0123456789abcdef0123456789abcdef';
const previousCodeSha = '76543210fedcba9876543210fedcba9876543210';
const profileBaseline = {
  asset: 'demo--main.profiles.json.gz',
  hash: 'b'.repeat(64),
  bytes: 456,
  sha256: 'c'.repeat(64),
  jsonBytes: 1234,
  schema: 3,
  encoding: 'branch-common-plus-exact-config-groups-v1',
  profiles: 2,
  configGroups: 1,
};
const input = stampIndex({
  schema: 2,
  generatedAt: '2026-08-06T00:00:00Z',
  sources: [{
    id: 'demo',
    branches: [{
      id: 'main',
      branch: 'main',
      asset: 'demo--main.json.gz',
      hash: 'a'.repeat(64),
      bytes: 123,
      state: 'fresh',
      assets: { profileBaselines: profileBaseline },
    }],
  }],
});

assert.equal(verifyCatalogRuntimeSurface(input).profileBaselineBranches, 1);
const noProfiles = structuredClone(input);
delete noProfiles.sources[0].branches[0].assets.profileBaselines;
assert.throws(() => verifyCatalogRuntimeSurface(noProfiles), /Profile baseline contract/);

const stamped = stampCatalogSnapshot(input, ref.toUpperCase(), {
  codeRef: 'main', codeSha: codeSha.toUpperCase(), complete: true,
});
if (stamped.assetRef !== ref || stamped.assetRefType !== 'git-commit') {
  throw new Error('snapshot stamp did not normalize the Git commit contract');
}
if (stamped.provenance?.codeRef !== 'main' || stamped.provenance?.codeSha !== codeSha ||
    stamped.provenance?.complete !== true) {
  throw new Error('snapshot stamp did not preserve code provenance');
}
if (stamped.sources[0].branches[0].asset !== 'demo--main.json.gz') {
  throw new Error('snapshot stamp changed the logical branch asset name');
}
const contract = indexContract(stamped);
if (stamped.hash !== contract.hash || stamped.bytes !== contract.bytes) {
  throw new Error('snapshot stamp did not refresh the index root contract');
}
const restamped = stampCatalogSnapshot(stamped, ref, { codeRef: 'main', codeSha, complete: true });
if (JSON.stringify(restamped) !== JSON.stringify(stamped)) throw new Error('identical snapshot stamp was not deterministic');
const fStamped = stampCatalogSnapshot(input, ref, { codeRef: 'fix-F', codeSha, complete: true });
if (fStamped.provenance?.codeRef !== 'fix-F' || fStamped.provenance?.complete !== true) {
  throw new Error('generic fix snapshot provenance was not accepted');
}
for (const invalid of [
  () => stampCatalogSnapshot(input, 'catalog-data'),
  () => stampCatalogSnapshot(input, ref, { codeRef: 'main', codeSha: 'bad', complete: true }),
  () => stampCatalogSnapshot(input, ref, { codeRef: 'feature/x', codeSha, complete: true }),
  () => stampCatalogSnapshot(noProfiles, ref, { codeRef: 'fix-F', codeSha, complete: true }),
]) {
  let rejected = false;
  try { invalid(); } catch { rejected = true; }
  if (!rejected) throw new Error('snapshot stamp accepted an invalid immutable identity/runtime surface');
}

const reusable = stampCatalogSnapshot(input, ref, {
  codeRef: 'dev', codeSha: previousCodeSha, complete: true,
});
const reuse = verifyReusableCatalogSnapshot(reusable, {
  repository: TEST_REPOSITORY,
  codeRef: 'dev',
  previousCodeSha,
});
if (reuse.assetRef !== ref || reuse.complete !== true) {
  throw new Error('reusable snapshot verification changed immutable identity');
}
const reusableF = stampCatalogSnapshot(input, ref, {
  codeRef: 'fix-F', codeSha: previousCodeSha, complete: true,
});
const reuseF = verifyReusableCatalogSnapshot(reusableF, {
  repository: TEST_REPOSITORY,
  codeRef: 'fix-F',
  previousCodeSha,
});
if (reuseF.assetRef !== ref || reuseF.complete !== true) {
  throw new Error('generic fix reusable snapshot verification changed immutable identity');
}
const legacyReusable = stampCatalogSnapshot(noProfiles, ref, {
  codeRef: 'fix-F', codeSha: previousCodeSha, complete: false,
});
assert.equal(verifyReusableCatalogSnapshot(legacyReusable, {
  repository: TEST_REPOSITORY,
  codeRef: 'fix-F',
  previousCodeSha,
}).complete, false, 'incomplete historical snapshot may be inspected but never promoted as complete');
for (const invalidReuse of [
  () => verifyReusableCatalogSnapshot(reusable, { repository: 'other/repo', codeRef: 'dev', previousCodeSha }),
  () => verifyReusableCatalogSnapshot(reusable, { repository: TEST_REPOSITORY, codeRef: 'staging', previousCodeSha }),
  () => verifyReusableCatalogSnapshot(reusable, { repository: TEST_REPOSITORY, codeRef: 'dev', previousCodeSha: codeSha }),
]) {
  let rejected = false;
  try { invalidReuse(); } catch { rejected = true; }
  if (!rejected) throw new Error('reusable snapshot verification accepted mismatched provenance');
}

const temp = mkdtempSync(join(tmpdir(), 'catalog-snapshot-'));
try {
  // Exercise real Git commits: a new asset tree inherits an old publication,
  // then becomes a clean manifest before receiving a new channel wrapper.
  const git = (...args) => {
    const result = spawnSync('git', ['-C', temp, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Snapshot Test');
  git('config', 'user.email', 'snapshot@example.invalid');
  const manifestFile = join(temp, 'manifest.json');
  const changed = structuredClone(reusable);
  changed.generatedAt = '2026-09-20T00:00:00Z';
  const manifest = prepareCatalogAssetManifest(changed);
  assert.equal(manifest.assetRef, undefined);
  assert.equal(manifest.assetRefType, undefined);
  assert.equal(manifest.provenance, undefined);
  assert.deepEqual(prepareCatalogAssetManifest(manifest), manifest);
  writeFileSync(join(temp, 'index.json'), JSON.stringify(manifest));
  git('add', 'index.json');
  git('commit', '--quiet', '-m', 'Create asset manifest');
  const immutableRef = git('rev-parse', 'HEAD');
  const committedManifest = JSON.parse(git('show', `${immutableRef}:index.json`));
  writeFileSync(manifestFile, JSON.stringify(committedManifest));
  for (const channel of ['fix-test', 'dev', 'staging', 'main']) {
    const publication = stampCatalogSnapshot(manifest, immutableRef, { codeRef: channel, codeSha, complete: true });
    assert.equal(verifyCatalogAssetManifest(publication, committedManifest).assetRef, immutableRef);
    const stale = stampCatalogSnapshot(manifest, ref, { codeRef: 'dev', codeSha, complete: true });
    assert.throws(() => verifyCatalogAssetManifest(publication, stale), /Worker asset identity mismatch/);
    const drift = stampIndex({ ...manifest, generatedAt: 'different' });
    assert.throws(() => verifyCatalogAssetManifest(publication, drift), /differ beyond/);
    assert.throws(() => verifyCatalogAssetManifest(publication, { ...manifest, hash: 'bad' }), /invalid index contract/);
    writeFileSync(join(temp, 'index.json'), JSON.stringify(publication));
    git('add', 'index.json');
    git('commit', '--quiet', '-m', `Publish ${channel}`);
    const cli = spawnSync(process.execPath, [
      fileURLToPath(new URL('./stamp-catalog-snapshot.mjs', import.meta.url)),
      'verify-assets', join(temp, 'index.json'), manifestFile,
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(git('show', `${immutableRef}:index.json`)), committedManifest);
  }
  // Every producing path must prepare before the asset commit and verify
  // after stamping; neither translation path may inherit old publication data.
  for (const [name, count] of [['catalog.yml', 2], ['translate.yml', 2]]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.equal((workflow.match(/stamp-catalog-snapshot\.mjs prepare-assets/g) || []).length, count);
    assert.equal((workflow.match(/stamp-catalog-snapshot\.mjs verify-assets/g) || []).length, count);
    for (const segment of workflow.split('asset_commit="').slice(1)) {
      assert(segment.includes('verify-assets'), `${name}: missing post-commit manifest verification`);
    }
  }
  for (const name of ['catalog-reuse.yml', 'catalog-production.yml']) {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert(workflow.includes('stamp-catalog-snapshot.mjs verify-assets'), `${name}: manifest verification missing`);
  }
  const file = join(temp, 'index.json');
  writeFileSync(file, JSON.stringify(input, null, 2) + '\n');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./stamp-catalog-snapshot.mjs', import.meta.url)),
    file,
    ref,
    'fix-F',
    codeSha,
    'true',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`snapshot CLI failed: ${result.stderr || result.stdout}`);
  }
  const cli = JSON.parse(readFileSync(file, 'utf8'));
  if (cli.assetRef !== ref || cli.hash !== indexContract(cli).hash || cli.provenance?.codeRef !== 'fix-F' ||
      cli.provenance?.codeSha !== codeSha) {
    throw new Error('snapshot CLI wrote an invalid generic fix index contract');
  }

  writeFileSync(file, JSON.stringify(reusableF, null, 2) + '\n');
  const reuseResult = spawnSync(process.execPath, [
    fileURLToPath(new URL('./stamp-catalog-snapshot.mjs', import.meta.url)),
    file,
    ref,
    'fix-F',
    codeSha,
    '',
    previousCodeSha,
  ], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: TEST_REPOSITORY },
  });
  if (reuseResult.status !== 0) {
    throw new Error(`snapshot reuse CLI failed: ${reuseResult.stderr || reuseResult.stdout}`);
  }
  const promoted = JSON.parse(readFileSync(file, 'utf8'));
  if (promoted.assetRef !== ref || promoted.provenance?.codeRef !== 'fix-F' ||
      promoted.provenance?.codeSha !== codeSha || promoted.provenance?.complete !== true) {
    throw new Error('snapshot reuse CLI did not preserve generic fix assets while advancing provenance');
  }
  for (const complete of [true, false]) {
    writeFileSync(file, JSON.stringify(stampCatalogSnapshot(input, ref, { codeRef: 'dev', codeSha, complete })));
    const prepared = spawnSync(process.execPath, [
      fileURLToPath(new URL('./stamp-catalog-snapshot.mjs', import.meta.url)), 'prepare-assets', file,
    ], { encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.stdout.trim(), String(complete));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), prepareCatalogAssetManifest(input));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('catalog snapshot checks passed');
