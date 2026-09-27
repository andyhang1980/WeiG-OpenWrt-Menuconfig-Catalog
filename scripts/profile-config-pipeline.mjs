#!/usr/bin/env node
// Execution-only sharding of the existing Native Profile generator. No second resolver.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { captureCatalogInputs, catalogInputsHash } from './catalog-inputs.mjs';
import { safeSlug } from './lib.mjs';
import {
  buildProfileGroupDocument, loadNativeProfileEntries, prepareNativeProfileResolver,
  generateNativeProfileRows, normalizeProfileGroupJobs, makeParityIndexes,
  verifyMakeDefconfigParity, writeProfileGroupAssets,
} from './generate-profile-config-groups.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => hash(JSON.stringify(value));
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readGzip = (path) => JSON.parse(gunzipSync(readFileSync(path)));
const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n');
const writeGzip = (path, value) => writeFileSync(path, gzipSync(JSON.stringify(value), { level: 9 }));
const seal = (body) => ({ ...body, planHash: jsonHash(body) });

export function verifyPlan(plan) {
  const { planHash, ...body } = plan || {};
  if (!planHash || jsonHash(body) !== planHash) throw new Error('Profile plan identity mismatch');
  return plan;
}

export function partitionProfileIndexes(indexes, count) {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Profile shard count must be 1..8');
  const shards = Array.from({ length: Math.min(count, indexes.length) }, () => []);
  indexes.forEach((index, offset) => shards[offset % shards.length].push(index));
  return shards;
}

export function createProfilePlan(entries, source, { maxShards = 4, codeSha = '', runId = '', treePath = '' } = {}) {
  if (!entries.length) throw new Error('Profile plan cannot be empty');
  if (![1, 4, 8].includes(maxShards)) throw new Error('Profile max shards must be 1, 4 or 8');
  if (!source?.commit || !source?.inputsHash) throw new Error('Profile plan requires exact source and feeds identity');
  // Interleave target-ordered entries so one large target cannot monopolize one shard.
  const shards = partitionProfileIndexes(entries.map((_, index) => index), entries.length > 700 ? maxShards : 1);
  const projected = entries.map(({ target, profile, selectors }) => ({
    target: { id: target.id, board: target.board || '', subtarget: target.subtarget || '' },
    profile: { id: profile.id, name: profile.name || profile.id }, selectors,
  }));
  return seal({ schema: 1, kind: 'native-profile-execution-plan', source, codeSha, runId,
    treePath, entries: projected, shards });
}

function assertInputs(tree, plan) {
  verifyPlan(plan);
  if (resolve(tree) !== plan.treePath) throw new Error('Prepared Native tree must be restored at its original path');
  if (plan.codeSha !== (process.env.GITHUB_SHA || '') || plan.runId !== (process.env.GITHUB_RUN_ID || '')) {
    throw new Error('Profile execution belongs to a different code commit or workflow run');
  }
  const inputs = captureCatalogInputs(tree);
  if (inputs.sourceCommit !== plan.source.commit || catalogInputsHash(inputs) !== plan.source.inputsHash) {
    throw new Error('Profile execution source/feeds differ from prepared Catalog inputs');
  }
}

export function decodeProfileShard(plan, document) {
  verifyPlan(plan);
  const indexes = plan.shards[document?.shard];
  if (document?.schema !== 1 || document.kind !== 'native-profile-rows' || document.planHash !== plan.planHash ||
      !Number.isInteger(document.shard) || !indexes || !Array.isArray(document.rows) || document.rows.length !== indexes.length) {
    throw new Error('Native Profile shard identity or coverage mismatch');
  }
  return document.rows.map(([index, rawBytes, pairs], offset) => {
    if (index !== indexes[offset] || !Array.isArray(pairs) || !pairs.length || !Number.isFinite(rawBytes) || rawBytes <= 0 ||
        pairs.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((value) => typeof value !== 'string'))) {
      throw new Error('Native Profile shard row identity or values mismatch');
    }
    const values = new Map(pairs);
    if (values.size !== pairs.length) throw new Error('Native Profile shard contains duplicate symbols');
    return { index, ...plan.entries[index], rawBytes, values };
  });
}

export function validateParityReceipts(plan, documents) {
  verifyPlan(plan);
  const seen = new Set();
  for (const receipt of documents) {
    const expected = plan.shards[receipt?.shard];
    if (receipt?.schema !== 1 || receipt.kind !== 'native-profile-parity-receipt' ||
        receipt.planHash !== plan.planHash || !Number.isInteger(receipt.shard) || !expected ||
        seen.has(receipt.shard) || JSON.stringify(receipt.indexes) !== JSON.stringify(expected)) {
      throw new Error('Native make defconfig parity receipt identity or coverage mismatch');
    }
    seen.add(receipt.shard);
  }
  if (seen.size !== plan.shards.length) throw new Error('Missing Native make defconfig parity shard');
  return plan.shards.reduce((count, indexes) => count + indexes.length, 0);
}

function matrixOutput(shards) {
  const line = `matrix=${JSON.stringify({ include: shards.map((_, shard) => ({ shard })) })}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}

async function main() {
  const [mode, ...tokens] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < tokens.length; i += 2) {
    if (!tokens[i].startsWith('--') || tokens[i + 1] == null) throw new Error('Expected --name value');
    args[tokens[i].slice(2)] = tokens[i + 1];
  }
  const tree = resolve(args.tree || 'work/upstream');
  const outDir = resolve(args.out || 'dist');
  const work = resolve(args.work || 'profile-work');
  mkdirSync(work, { recursive: true });
  const planPath = join(work, 'plan.json');
  const started = Date.now();
  if (mode === 'finalize') {
    for (const stage of ['NATIVE', 'MERGE', 'PARITY']) {
      const result = process.env[`PROFILE_${stage}_RESULT`];
      if (result && result !== 'success') throw new Error(`Native Profile ${stage.toLowerCase()} jobs did not complete (${result}); inspect their stage logs. No complete assets will be published.`);
    }
  }
  if (mode === 'prepare') {
    if (!args['source-id'] || !args.branch) throw new Error('Profile prepare requires source-id and branch');
    const slug = `${safeSlug(args['source-id'])}--${safeSlug(args.branch)}`;
    const meta = readJSON(join(outDir, `${slug}.meta.json`));
    if (meta.source.id !== args['source-id'] || meta.source.branch !== args.branch) throw new Error('Catalog meta identity mismatch');
    const entries = loadNativeProfileEntries(tree, outDir, slug);
    prepareNativeProfileResolver(tree);
    const plan = createProfilePlan(entries, meta.source, {
      maxShards: Number(args['max-shards'] || 4), treePath: tree,
      codeSha: process.env.GITHUB_SHA || '', runId: process.env.GITHUB_RUN_ID || '',
    });
    assertInputs(tree, plan);
    writeJSON(planPath, plan);
    matrixOutput(plan.shards);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `distributed=${plan.shards.length > 1}\n`);
    console.log(`Prepared ${entries.length} Profiles / ${plan.shards.length} shards / ${Date.now() - started} ms`);
    return;
  }
  const plan = verifyPlan(readJSON(planPath));
  const slug = `${safeSlug(plan.source.id)}--${safeSlug(plan.source.branch)}`;
  const shard = Number(args.shard);
  if (mode === 'shard') {
    if (!Number.isInteger(shard) || !plan.shards[shard]) throw new Error('Unknown Profile shard');
    assertInputs(tree, plan);
    const indexes = plan.shards[shard];
    const jobs = Math.min(indexes.length, normalizeProfileGroupJobs(args.jobs || process.env.PROFILE_GROUP_JOBS));
    const { rows, nativeConfigMs } = await generateNativeProfileRows(tree, indexes.map((i) => plan.entries[i]),
      join(work, `native-work-${shard}`), jobs);
    assertInputs(tree, plan);
    writeGzip(join(work, `rows-${shard}.json.gz`), {
      schema: 1, kind: 'native-profile-rows', planHash: plan.planHash, shard,
      fields: ['profileIndex', 'rawBytes', 'symbolValuePairs'],
      rows: rows.map((row, i) => [indexes[i], row.rawBytes, [...row.values]]),
      metrics: { nativeConfigMs, concurrency: jobs },
    });
    return;
  }
  const draftPath = join(work, 'draft.json.gz');
  const parityPath = join(work, 'parity-plan.json.gz');
  if (mode === 'merge') {
    const rowsDir = resolve(args.rows || 'profile-rows');
    const files = readdirSync(rowsDir).filter((name) => /^rows-\d+\.json\.gz$/.test(name)).sort();
    if (files.length !== plan.shards.length) throw new Error('Missing or extra Native Profile shard');
    const rows = new Array(plan.entries.length);
    const seen = new Set();
    const times = [];
    let concurrency = 0;
    for (const file of files) {
      const document = readGzip(join(rowsDir, file));
      if (seen.has(document.shard)) throw new Error('Duplicate Native Profile shard');
      const decoded = decodeProfileShard(plan, document);
      for (const row of decoded) rows[row.index] = row;
      seen.add(document.shard);
      times.push(document.metrics.nativeConfigMs);
      concurrency = Math.max(concurrency, document.metrics.concurrency);
    }
    if (rows.filter(Boolean).length !== plan.entries.length) throw new Error('Incomplete Native Profile coverage');
    const payload = buildProfileGroupDocument(rows, plan.source, {
      rawConfigBytes: rows.reduce((sum, row) => sum + row.rawBytes, 0), concurrency,
    });
    const indexes = makeParityIndexes(rows, payload.identity.aliases, payload.identity.overrides, payload.identity.targetOverrides);
    // Preserve the GLOBAL sample plan, including aliases crossing shard boundaries.
    const samples = indexes.map((index) => ({ ...plan.entries[index], index, values: [...rows[index].values] }));
    payload.metrics.shards = plan.shards.length;
    payload.metrics.nativeShardMs = times;
    payload.metrics.mergeMs = Date.now() - started;
    writeGzip(draftPath, payload);
    const parity = seal({ schema: 1, kind: 'native-profile-parity-plan', inputPlanHash: plan.planHash,
      draftHash: hash(readFileSync(draftPath)), samples,
      shards: partitionProfileIndexes(indexes, plan.shards.length) });
    writeGzip(parityPath, parity);
    matrixOutput(parity.shards);
    console.log(`Merged ${rows.length} Profiles / ${indexes.length} native parity samples / ${payload.metrics.mergeMs} ms`);
    return;
  }
  const parity = verifyPlan(readGzip(parityPath));
  if (parity.inputPlanHash !== plan.planHash) throw new Error('Parity plan belongs to different Native input');
  if (mode === 'parity') {
    if (!Number.isInteger(shard) || !parity.shards[shard]) throw new Error('Unknown parity shard');
    assertInputs(tree, plan);
    const rows = [];
    for (const row of parity.samples) rows[row.index] = { ...row, values: new Map(row.values) };
    verifyMakeDefconfigParity(tree, rows, [], [], [], parity.shards[shard]);
    assertInputs(tree, plan);
    writeJSON(join(work, `parity-${shard}.json`), { schema: 1, kind: 'native-profile-parity-receipt',
      planHash: parity.planHash, shard, indexes: parity.shards[shard], elapsedMs: Date.now() - started });
    return;
  }
  if (mode === 'finalize') {
    if (hash(readFileSync(draftPath)) !== parity.draftHash) throw new Error('Native Profile draft differs from parity plan');
    const receiptsDir = resolve(args.receipts || 'profile-receipts');
    const receipts = readdirSync(receiptsDir).filter((name) => /^parity-\d+\.json$/.test(name)).map((name) => readJSON(join(receiptsDir, name)));
    const nativeParitySamples = validateParityReceipts(parity, receipts);
    const payload = readGzip(draftPath);
    const meta = readJSON(join(outDir, `${slug}.meta.json`));
    if (jsonHash(payload.source) !== jsonHash(plan.source) || jsonHash(meta.source) !== jsonHash(plan.source)) {
      throw new Error('Final Profile assets differ from prepared Catalog source');
    }
    payload.generatedAt = new Date().toISOString();
    payload.metrics.nativeParitySamples = nativeParitySamples;
    payload.metrics.parityShardMs = receipts.map((r) => r.elapsedMs);
    // Compute time, not runner queue/artifact transfer latency.
    payload.metrics.generationMs = Math.max(...payload.metrics.nativeShardMs) + payload.metrics.mergeMs +
      Math.max(...payload.metrics.parityShardMs);
    writeProfileGroupAssets(payload, meta, outDir, slug);
    return;
  }
  throw new Error(`Unknown Native Profile pipeline mode: ${mode}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
