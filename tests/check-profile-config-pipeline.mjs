import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  createProfilePlan, verifyPlan, partitionProfileIndexes, decodeProfileShard, validateParityReceipts,
} from '../scripts/profile-config-pipeline.mjs';
import {
  buildIdentityTopology, deriveIdentityValues, buildProfileGroupDocument, makeParityIndexes,
  generateNativeProfileRows, verifyMakeDefconfigParity, mapConcurrentOrdered,
} from '../scripts/generate-profile-config-groups.mjs';

const script = resolve('scripts/profile-config-pipeline.mjs');
const source = { id: 'Fixture', branch: 'test', commit: 'a'.repeat(40), inputsHash: 'b'.repeat(64) };
const entries = Array.from({ length: 704 }, (_, i) => {
  const target = `board/sub${Math.floor(i / 32)}`;
  return {
    target: { id: target, board: 'board', subtarget: `sub${Math.floor(i / 32)}` },
    profile: { id: `DEVICE_${i}`, name: `Profile ${i}` },
    selectors: { board: 'TARGET_board', target: `TARGET_${target.replace('/', '_')}`, profile: `TARGET_DEVICE_${i}` },
  };
});
const topology = buildIdentityTopology(entries);
const rows = entries.map((entry, i) => ({ ...entry, rawBytes: 100,
  values: new Map([...deriveIdentityValues(topology, i === 0 ? 1 : i), ['COMMON', 'y'],
    ['MODULE', i % 3 === 0 ? 'm' : 'n'], ['TEXT', '"a b"'], ['INTEGER', '512'], ['HEX', '0x10']]),
}));
const plan = createProfilePlan(entries, source);
assert.equal(plan.shards.length, 4);
assert.equal(createProfilePlan(entries, source, { maxShards: 8 }).shards.length, 8);
assert.equal(createProfilePlan(entries.slice(0, 6), source).shards.length, 1);
assert.throws(() => createProfilePlan(entries, source, { maxShards: 9 }), /max shards/);
assert.throws(() => createProfilePlan([], source), /empty/);
assert.throws(() => createProfilePlan(entries, {}), /exact source/);
assert.throws(() => partitionProfileIndexes([0], 0), /1..8/);
assert.deepEqual(partitionProfileIndexes([0, 1, 2, 3, 4], 4), [[0, 4], [1], [2], [3]]);
assert.throws(() => verifyPlan({ ...plan, source: { ...source, commit: 'c'.repeat(40) } }), /identity/);

const documentFor = (p, shard) => ({ schema: 1, kind: 'native-profile-rows', planHash: p.planHash, shard,
  rows: p.shards[shard].map((index) => [index, rows[index].rawBytes, [...rows[index].values]]),
  metrics: { nativeConfigMs: 10, concurrency: 4 },
});
const decoded = new Array(rows.length);
for (let shard = plan.shards.length - 1; shard >= 0; shard--) {
  for (const row of decodeProfileShard(plan, documentFor(plan, shard))) decoded[row.index] = row;
}
const original = buildProfileGroupDocument(rows, source, { generatedAt: 'fixed' });
const merged = buildProfileGroupDocument(decoded, source, { generatedAt: 'fixed' });
assert.deepEqual(merged, original, 'Sharding must not change global groups, aliases, common values or reconstruction');
assert(original.identity.aliases.some(([a, b]) => a === 0 && b === 1), 'fixture must include a cross-shard alias');
const indexes = makeParityIndexes(rows, original.identity.aliases, original.identity.overrides, original.identity.targetOverrides);
assert(indexes.includes(0) && indexes.includes(1));
assert.throws(() => decodeProfileShard(plan, { ...documentFor(plan, 0), planHash: 'bad' }), /identity/);
assert.throws(() => decodeProfileShard(plan, { ...documentFor(plan, 0), rows: [] }), /coverage/);
const duplicate = documentFor(plan, 0);
duplicate.rows[0][2].push(duplicate.rows[0][2][0]);
assert.throws(() => decodeProfileShard(plan, duplicate), /duplicate symbols/);
const wrongOrder = documentFor(plan, 0);
wrongOrder.rows.reverse();
assert.throws(() => decodeProfileShard(plan, wrongOrder), /row identity/);

const directory = mkdtempSync(join(tmpdir(), 'catalog-profile-shards-'));
try {
  const work = join(directory, 'profile-work');
  const inputs = join(directory, 'rows');
  const receiptsDir = join(directory, 'receipts');
  const out = join(directory, 'dist');
  for (const path of [work, inputs, receiptsDir, out]) mkdirSync(path);
  const json = (path, value) => writeFileSync(path, JSON.stringify(value));
  const compressed = (path, value) => writeFileSync(path, gzipSync(JSON.stringify(value)));
  const invoke = (mode, extra = []) => spawnSync(process.execPath,
    [script, mode, '--work', work, '--rows', inputs, '--receipts', receiptsDir, '--out', out, ...extra],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  json(join(work, 'plan.json'), plan);
  for (let shard = 0; shard < plan.shards.length; shard++) compressed(join(inputs, `rows-${shard}.json.gz`), documentFor(plan, shard));
  const result = invoke('merge');
  assert.equal(result.status, 0, result.stderr);
  const parity = JSON.parse(gunzipSync(readFileSync(join(work, 'parity-plan.json.gz'))));
  assert.deepEqual(parity.shards.flat().sort((a, b) => a - b), indexes);
  const receipts = parity.shards.map((part, shard) => ({ schema: 1, kind: 'native-profile-parity-receipt',
    planHash: parity.planHash, shard, indexes: part, elapsedMs: 1 }));
  assert.equal(validateParityReceipts(parity, receipts), indexes.length);
  assert.throws(() => validateParityReceipts(parity, receipts.slice(1)), /Missing/);
  assert.throws(() => validateParityReceipts(parity, [...receipts, receipts[0]]), /coverage/);
  assert.throws(() => validateParityReceipts(parity, [{ ...receipts[0], planHash: plan.planHash }, ...receipts.slice(1)]), /identity/);
  json(join(out, 'fixture--test.meta.json'), { source });
  assert.notEqual(invoke('finalize').status, 0, 'missing receipts cannot write the asset');
  assert(!readdirSync(out).includes('fixture--test.profiles.json.gz'));
  for (const receipt of receipts) json(join(receiptsDir, `parity-${receipt.shard}.json`), receipt);
  const final = invoke('finalize');
  assert.equal(final.status, 0, final.stderr);
  const asset = JSON.parse(gunzipSync(readFileSync(join(out, 'fixture--test.profiles.json.gz'))));
  for (const field of ['schema', 'encoding', 'profileFields', 'stateGroups', 'source', 'identity', 'symbols', 'common', 'groups', 'profiles']) {
    assert.deepEqual(asset[field], original[field], `final ${field} differs from the single-run generator`);
  }
  assert.equal(asset.metrics.reconstructionMismatches, 0);
  assert.equal(asset.metrics.nativeParitySamples, indexes.length);
  // Integrity checks reject mixed attempts/inputs, absent shards and duplicate shard payloads.
  const draft = readFileSync(join(work, 'draft.json.gz'));
  writeFileSync(join(work, 'draft.json.gz'), gzipSync('{}'));
  assert.match(invoke('finalize').stderr, /draft differs/);
  writeFileSync(join(work, 'draft.json.gz'), draft);
  rmSync(join(inputs, 'rows-0.json.gz'));
  assert.match(invoke('merge').stderr, /Missing or extra/);
  compressed(join(inputs, 'rows-0.json.gz'), documentFor(plan, 1));
  assert.match(invoke('merge').stderr, /Duplicate/);
  compressed(join(inputs, 'rows-0.json.gz'), { ...documentFor(plan, 0), planHash: 'wrong' });
  assert.match(invoke('merge').stderr, /identity/);

  const stage = resolve('scripts/run-stage.sh');
  const stageEnv = { ...process.env, GITHUB_WORKSPACE: directory.replaceAll('\\', '/'), CATALOG_JOB_KEY: 'fixture', CATALOG_ORDER: '01' };
  for (const [name, code] of [['success', 0], ['failure', 7]]) {
    const r = spawnSync('bash', [stage, name, 'bash', '-c', `echo durable-progress; exit ${code}`], { env: stageEnv, encoding: 'utf8' });
    assert.equal(r.status, code ? 1 : 0, r.stderr);
    const log = readFileSync(join(directory, 'failure-logs', `01-fixture--${name}.log`), 'utf8');
    assert.match(log, /durable-progress/);
    assert.match(r.stdout, /durable-progress/, 'runner console must receive progress before command completion');
  }
  if (process.platform !== 'win32') {
    const r = spawnSync('timeout', ['--signal=TERM', '1', 'bash', stage, 'timeout', 'bash', '-c', 'echo before-timeout; sleep 30'],
      { env: stageEnv, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(r.status, 0);
    assert.match(readFileSync(join(directory, 'failure-logs', '01-fixture--timeout.log'), 'utf8'), /before-timeout/);
  }

  const prior = join(directory, 'prior.attempt.json');
  json(prior, { upstreamCommit: source.commit, outcomes: { tools: 'success', feeds: 'failure', 'profile-plan': 'skipped' },
    feedFailure: { reason: 'fixture-failure' } });
  execFileSync(process.execPath, [resolve('scripts/write-attempt.mjs')], { cwd: directory, env: {
    ...process.env, SOURCE_ID: source.id, SOURCE_LABEL: 'Fixture', SOURCE_REPO: 'fixture/source', SOURCE_BRANCH: source.branch,
    RUN_URL: 'https://example.invalid/run', PREVIOUS_ATTEMPT_FILE: prior, JOB_STATUS: 'failure',
    EXPERIMENT_STAGE: 'profile-config-groups', EXPERIMENT_OUTCOME: 'failure',
  } });
  const attemptDir = join(directory, 'attempts');
  const attempt = JSON.parse(readFileSync(join(attemptDir, readdirSync(attemptDir).find((n) => n.endsWith('.attempt.json')))));
  assert.equal(attempt.stage, 'feeds', 'finalization must preserve the first preparation failure');
  assert.equal(attempt.upstreamCommit, source.commit);
  assert.equal(attempt.feedFailure.reason, 'fixture-failure');

  // CI supplies its already-pinned upstream checkout: reuse its REAL conf binary.
  // The synthetic Kconfig fixture exercises orchestration without thousands of Profiles.
  if (process.env.KCONFIG_NATIVE_TEST_TREE && process.platform !== 'win32') {
    const upstream = resolve(process.env.KCONFIG_NATIVE_TEST_TREE);
    execFileSync('make', ['-C', upstream, 'scripts/config/conf'], { stdio: 'pipe' });
    const nativeTree = join(directory, 'native');
    mkdirSync(join(nativeTree, 'scripts', 'config'), { recursive: true });
    copyFileSync(join(upstream, 'scripts', 'config', 'conf'), join(nativeTree, 'scripts', 'config', 'conf'));
    const nativeEntries = entries.slice(0, 6);
    writeFileSync(join(nativeTree, 'Config.in'), [
      'config HAVE_DOT_CONFIG\n bool\n default y',
      'config TARGET_board\n bool "Board"', 'config TARGET_board_sub0\n bool "Target"',
      ...nativeEntries.map((row) => `config ${row.selectors.profile}\n bool "${row.profile.id}"`),
      'config SAMPLE_STRING\n string\n default "native text"',
      'config SAMPLE_INT\n int\n default 512', 'config SAMPLE_HEX\n hex\n default 0x10', '',
    ].join('\n'));
    writeFileSync(join(nativeTree, 'Makefile'), '.PHONY: defconfig\ndefconfig:\n\tscripts/config/conf --defconfig=.config -w .config Config.in\n');
    const single = await generateNativeProfileRows(nativeTree, nativeEntries, join(directory, 'single'), 2);
    const parts = [];
    for (const indexes of partitionProfileIndexes([0, 1, 2, 3, 4, 5], 4)) {
      const generated = await generateNativeProfileRows(nativeTree, indexes.map((i) => nativeEntries[i]), join(directory, 'native-shard'), 2);
      indexes.forEach((index, i) => { parts[index] = generated.rows[i]; });
    }
    const options = { generatedAt: 'fixed' };
    assert.deepEqual(buildProfileGroupDocument(parts, source, options), buildProfileGroupDocument(single.rows, source, options));
    for (const part of partitionProfileIndexes([0, 1, 2, 3, 4, 5], 4)) verifyMakeDefconfigParity(nativeTree, parts, [], [], [], part);
    console.log('Native upstream conf oracle: single/sharded generation and make defconfig parity passed');
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const workflow = readFileSync(resolve('.github/workflows/catalog-branch.yml'), 'utf8');
assert.match(workflow, /workflow_call:/);
assert.match(workflow, /max-parallel: \$\{\{ inputs.shards \}\}/);
assert.match(workflow, /needs: \[prepare, native, group, parity\]/);
assert.match(workflow, /tar -I 'gzip -1' -cf native-tree.tar.gz work\/upstream/);
assert.match(workflow, /tar -xzf native-tree.tar.gz/);
assert(!workflow.includes('continue-on-error: true\n        run: bash scripts/run-stage.sh profile-'));
let writerFinished = false;
await assert.rejects(mapConcurrentOrdered([0, 1, 2], async (_, i) => {
  if (i === 0) { await new Promise((done) => setTimeout(done, 1)); throw new Error('worker failed'); }
  await new Promise((done) => setTimeout(done, 20));
  writerFinished = true;
}, 2), /worker failed/);
assert(writerFinished, 'worker pool must wait for outstanding writes before rejecting');
console.log('Native Profile sharding checks passed: deterministic 1/4/8 shards, exact grouping/parity coverage, invalid/missing/duplicate input rejection, durable stage logs, original failure attribution.');
