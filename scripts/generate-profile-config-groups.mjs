#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { captureCatalogInputs, catalogInputsHash } from './catalog-inputs.mjs';
import {
  parseInfoRecords, parseKconfigTree, resolveTargetSelectors, safeSlug, targetBuildContract,
} from './lib.mjs';
import {
  buildProfileSeed, compareConfigSemantics, configSemanticHash, parseConfigSymbols,
} from './profile-config-contract.mjs';

const execFileAsync = promisify(execFile);
const FIXED_IDENTITY_SYMBOLS = Object.freeze(['TARGET_BOARD', 'TARGET_SUBTARGET', 'TARGET_PROFILE']);
export const PROFILE_GROUP_SCHEMA = 3;
export const PROFILE_GROUP_ENCODING = 'branch-common-plus-exact-config-groups-v1';
export const PROFILE_GROUP_FIELDS = Object.freeze([
  'target', 'board', 'subtarget', 'profile', 'name', 'boardSelector', 'selector', 'targetSelector',
  'nativeHash', 'symbolCount', 'groupId',
]);
export const PROFILE_GROUP_STATE_GROUPS = Object.freeze(['n', 'm', 'y', 'otherIndexValue']);

export function normalizeProfileGroupJobs(value, parallelism = availableParallelism()) {
  const requested = Number.parseInt(String(value || ''), 10);
  if (Number.isFinite(requested) && requested > 0) return requested;
  return Math.max(1, Number(parallelism) || 1);
}

export async function mapConcurrentOrdered(items, worker, concurrency = 1) {
  const rows = Array.from(items || []);
  const results = new Array(rows.length);
  if (!rows.length) return results;
  const jobs = Math.max(1, Math.min(rows.length, Number(concurrency) || 1));
  let cursor = 0;
  let failure;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (!failure) {
      const index = cursor++;
      if (index >= rows.length) return;
      try { results[index] = await worker(rows[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  // Drain in-flight writers before callers clean their shared temporary directory.
  if (failure) throw failure;
  return results;
}

export function intersectCommonValues(common, values) {
  if (common === null) return new Map(values);
  const next = new Map(common);
  for (const [symbol, value] of next) {
    if (!values.has(symbol) || values.get(symbol) !== value) next.delete(symbol);
  }
  return next;
}

export function groupConfigPairs(pairs) {
  const grouped = [[], [], [], []];
  for (const pair of pairs || []) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 0) {
      throw new Error('invalid Profile Config Group pair');
    }
    const [index, value] = pair;
    if (value === 'n') grouped[0].push(index);
    else if (value === 'm') grouped[1].push(index);
    else if (value === 'y') grouped[2].push(index);
    else grouped[3].push(index, value);
  }
  return grouped;
}

export function ungroupConfigPairs(grouped) {
  if (!Array.isArray(grouped) || grouped.length !== PROFILE_GROUP_STATE_GROUPS.length ||
      grouped.some((row) => !Array.isArray(row)) || grouped[3].length % 2 !== 0) {
    throw new Error('invalid Profile Config Group grouped state payload');
  }
  const pairs = [];
  for (const index of grouped[0]) pairs.push([index, 'n']);
  for (const index of grouped[1]) pairs.push([index, 'm']);
  for (const index of grouped[2]) pairs.push([index, 'y']);
  for (let offset = 0; offset < grouped[3].length; offset += 2) {
    pairs.push([grouped[3][offset], grouped[3][offset + 1]]);
  }
  return pairs;
}

function quote(value) {
  return `"${String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function scalar(value) {
  const text = String(value ?? '');
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return text;
}

function mapEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [symbol, value] of left) if (!right.has(symbol) || right.get(symbol) !== value) return false;
  return true;
}

function sortedEntries(values) {
  return [...values].sort(([left], [right]) => left.localeCompare(right));
}

function normalizedProfileMeta(row) {
  return {
    target: row.target.id,
    board: row.target.board || '',
    subtarget: row.target.subtarget || '',
    profile: row.profile.id,
    name: row.profile.name || row.profile.id,
    boardSelector: row.selectors.board || '',
    targetSelector: row.selectors.target || '',
    selector: row.selectors.profile || '',
  };
}

export function buildIdentityTopology(rows) {
  const profiles = rows.map(normalizedProfileMeta);
  const boardSelectors = new Set(profiles.map((row) => row.boardSelector).filter(Boolean));
  const targetSelectorsByBoard = new Map();
  const profileSelectorsByTarget = new Map();
  const profilesByIdentity = new Map();
  const profilesByTarget = new Map();
  const identitySymbols = new Set(FIXED_IDENTITY_SYMBOLS);
  for (const symbol of boardSelectors) identitySymbols.add(symbol);
  profiles.forEach((row, index) => {
    if (!targetSelectorsByBoard.has(row.board)) targetSelectorsByBoard.set(row.board, new Set());
    if (row.targetSelector) {
      targetSelectorsByBoard.get(row.board).add(row.targetSelector);
      identitySymbols.add(row.targetSelector);
    }
    if (!profileSelectorsByTarget.has(row.target)) profileSelectorsByTarget.set(row.target, new Set());
    if (row.selector) {
      profileSelectorsByTarget.get(row.target).add(row.selector);
      identitySymbols.add(row.selector);
    }
    const identityKey = `${row.board}\0${row.subtarget}\0${row.profile}`;
    const identityIndexes = profilesByIdentity.get(identityKey) || [];
    identityIndexes.push(index);
    profilesByIdentity.set(identityKey, identityIndexes);
    const targetIndexes = profilesByTarget.get(row.target) || [];
    targetIndexes.push(index);
    profilesByTarget.set(row.target, targetIndexes);
  });
  return {
    profiles, boardSelectors, targetSelectorsByBoard, profileSelectorsByTarget,
    profilesByIdentity, profilesByTarget, identitySymbols,
  };
}

function baseIdentityValues(topology, profileIndex) {
  const row = topology.profiles[profileIndex];
  if (!row) throw new Error(`invalid Profile identity index: ${profileIndex}`);
  const values = new Map([
    ['TARGET_BOARD', quote(row.board)],
    ['TARGET_SUBTARGET', quote(row.subtarget)],
    ['TARGET_PROFILE', quote(row.profile)],
  ]);
  const selectors = new Set(topology.boardSelectors);
  for (const symbol of topology.targetSelectorsByBoard.get(row.board) || []) selectors.add(symbol);
  for (const symbol of topology.profileSelectorsByTarget.get(row.target) || []) selectors.add(symbol);
  for (const symbol of selectors) values.set(symbol, 'n');
  for (const symbol of [row.boardSelector, row.targetSelector, row.selector]) {
    if (symbol) values.set(symbol, 'y');
  }
  return values;
}

function applyIdentityOverride(values, pairs) {
  const next = new Map(values);
  for (const [symbol, value] of pairs || []) next.set(symbol, value);
  return next;
}

export function deriveIdentityValues(topology, profileIndex, targetOverrides = new Map()) {
  const row = topology.profiles[profileIndex];
  return applyIdentityOverride(baseIdentityValues(topology, profileIndex), targetOverrides.get(row.target));
}

export function actualIdentityValues(values, topology) {
  return new Map([...values].filter(([symbol]) => topology.identitySymbols.has(symbol)));
}

function fixedOnlyDelta(actual, derived) {
  const fixed = new Set(FIXED_IDENTITY_SYMBOLS);
  const symbols = new Set([...actual.keys(), ...derived.keys()]);
  const delta = [];
  for (const symbol of symbols) {
    const left = actual.get(symbol);
    const right = derived.get(symbol);
    if (left === right) continue;
    if (!fixed.has(symbol) || !actual.has(symbol)) return null;
    delta.push([symbol, left]);
  }
  return delta.sort(([left], [right]) => left.localeCompare(right));
}

export function discoverTargetIdentityOverrides(rows, topology) {
  const targetOverrides = new Map();
  for (const [target, indexes] of topology.profilesByTarget) {
    let candidate = null;
    let valid = true;
    for (const index of indexes) {
      const actual = actualIdentityValues(rows[index].values, topology);
      const derived = baseIdentityValues(topology, index);
      const delta = fixedOnlyDelta(actual, derived);
      if (delta === null) {
        valid = false;
        break;
      }
      const key = JSON.stringify(delta);
      if (candidate === null) candidate = { key, delta };
      else if (candidate.key !== key) {
        valid = false;
        break;
      }
    }
    if (valid && candidate?.delta.length) targetOverrides.set(target, candidate.delta);
  }
  return targetOverrides;
}

export function resolveIdentityProfileIndex(values, topology, requestedIndex, targetOverrides = new Map()) {
  const actual = actualIdentityValues(values, topology);
  if (mapEqual(actual, deriveIdentityValues(topology, requestedIndex, targetOverrides))) return requestedIndex;
  const board = scalar(values.get('TARGET_BOARD'));
  const subtarget = scalar(values.get('TARGET_SUBTARGET'));
  const profile = scalar(values.get('TARGET_PROFILE'));
  const candidates = topology.profilesByIdentity.get(`${board}\0${subtarget}\0${profile}`) || [];
  const exact = candidates.filter((index) =>
    mapEqual(actual, deriveIdentityValues(topology, index, targetOverrides)));
  return exact.length === 1 ? exact[0] : -1;
}

function resolveIdentity(rows, topology, requestedIndex, targetOverrides) {
  const profileIndex = resolveIdentityProfileIndex(
    rows[requestedIndex].values, topology, requestedIndex, targetOverrides,
  );
  if (profileIndex >= 0) return { profileIndex, override: null };
  const actual = actualIdentityValues(rows[requestedIndex].values, topology);
  if (!actual.size) {
    const requested = topology.profiles[requestedIndex];
    throw new Error(`Native Profile identity is empty for ${requested.target}/${requested.profile}`);
  }
  return { profileIndex: requestedIndex, override: sortedEntries(actual) };
}

function semanticValues(values, topology) {
  return new Map([...values].filter(([symbol]) => !topology.identitySymbols.has(symbol)));
}

function mapPairs(values, indexBySymbol, common = null) {
  return [...values]
    .filter(([symbol, value]) => !common || !common.has(symbol) || common.get(symbol) !== value)
    .map(([symbol, value]) => [indexBySymbol.get(symbol), value])
    .sort((left, right) => left[0] - right[0]);
}

function reconstructSemantic(symbols, commonGroups, deltaGroups) {
  const values = new Map();
  for (const [index, value] of [...ungroupConfigPairs(commonGroups), ...ungroupConfigPairs(deltaGroups)]) {
    const symbol = symbols[index];
    if (!symbol) throw new Error(`invalid Profile Config Group symbol index: ${index}`);
    values.set(symbol, value);
  }
  return values;
}

function exactGroup(semanticRows) {
  const buckets = new Map();
  const groups = [];
  const groupIds = [];
  for (let index = 0; index < semanticRows.length; index += 1) {
    const values = semanticRows[index];
    const hash = configSemanticHash(values);
    const bucket = buckets.get(hash) || [];
    let groupId = bucket.find((candidate) => compareConfigSemantics(groups[candidate].values, values).equal);
    if (groupId === undefined) {
      groupId = groups.length;
      groups.push({ values: new Map(values), hash, members: [] });
      bucket.push(groupId);
      buckets.set(hash, bucket);
    }
    groups[groupId].members.push(index);
    groupIds[index] = groupId;
  }
  return { groups, groupIds };
}

export function buildProfileGroupDocument(rows, source, options = {}) {
  if (!rows.length) throw new Error('Profile Config Group input is empty');
  const topology = buildIdentityTopology(rows);
  const targetOverrideMap = discoverTargetIdentityOverrides(rows, topology);
  const identityResolutions = rows.map((_, index) =>
    resolveIdentity(rows, topology, index, targetOverrideMap));
  const identityProfileIndexes = identityResolutions.map((item) => item.profileIndex);
  const identityOverrides = identityResolutions
    .map((item, index) => item.override ? [index, item.override] : null)
    .filter(Boolean);
  const identityOverrideByProfile = new Map(identityOverrides);
  const semanticRows = rows.map((row) => semanticValues(row.values, topology));
  let common = null;
  for (const values of semanticRows) common = intersectCommonValues(common, values);
  const { groups, groupIds } = exactGroup(semanticRows);
  const symbols = [...new Set(semanticRows.flatMap((values) => [...values.keys()]))].sort();
  const indexBySymbol = new Map(symbols.map((symbol, index) => [symbol, index]));
  const commonPairs = mapPairs(common || new Map(), indexBySymbol);
  const commonGroups = groupConfigPairs(commonPairs);
  const groupRows = groups.map((group) => groupConfigPairs(mapPairs(group.values, indexBySymbol, common)));
  const profiles = rows.map((row, index) => {
    const meta = topology.profiles[index];
    return [
      meta.target, meta.board, meta.subtarget, meta.profile, meta.name, meta.boardSelector, meta.selector, meta.targetSelector,
      configSemanticHash(row.values), row.values.size, groupIds[index],
    ];
  });
  const identityAliases = identityResolutions
    .map((item, index) => !item.override && item.profileIndex !== index ? [index, item.profileIndex] : null)
    .filter(Boolean);
  const targetOverrides = [...targetOverrideMap.entries()].sort(([left], [right]) => left.localeCompare(right));

  let reconstructionMismatches = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const values = reconstructSemantic(symbols, commonGroups, groupRows[groupIds[index]]);
    const identityValues = identityOverrideByProfile.has(index)
      ? new Map(identityOverrideByProfile.get(index))
      : deriveIdentityValues(topology, identityProfileIndexes[index], targetOverrideMap);
    for (const [symbol, value] of identityValues) values.set(symbol, value);
    const parity = compareConfigSemantics(rows[index].values, values);
    if (!parity.equal || parity.leftHash !== profiles[index][8]) reconstructionMismatches += 1;
  }
  if (reconstructionMismatches) throw new Error(`Profile Config Group reconstruction mismatches: ${reconstructionMismatches}`);

  const sizes = groups.map((group) => group.members.length);
  const semanticStatePairs = semanticRows.reduce((sum, values) => sum + values.size, 0);
  const groupStatePairs = groups.reduce((sum, group) => sum + group.values.size, 0);
  const groupDeltaPairs = groups.reduce((sum, group) => sum + mapPairs(group.values, indexBySymbol, common).length, 0);
  return {
    schema: PROFILE_GROUP_SCHEMA,
    kind: 'profile-baselines',
    encoding: PROFILE_GROUP_ENCODING,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source,
    profileFields: PROFILE_GROUP_FIELDS,
    stateGroups: PROFILE_GROUP_STATE_GROUPS,
    identity: {
      mode: 'catalog-target-tree-v1',
      fixed: FIXED_IDENTITY_SYMBOLS,
      targetOverrides,
      aliases: identityAliases,
      overrides: identityOverrides,
    },
    symbols,
    common: commonGroups,
    groups: groupRows,
    profiles,
    metrics: {
      profiles: profiles.length,
      configGroups: groups.length,
      sharedGroups: sizes.filter((size) => size > 1).length,
      profilesInSharedGroups: sizes.filter((size) => size > 1).reduce((sum, size) => sum + size, 0),
      largestGroup: Math.max(0, ...sizes),
      identitySymbols: topology.identitySymbols.size,
      targetIdentityOverrides: targetOverrides.length,
      identityAliases: identityAliases.length,
      identityOverrides: identityOverrides.length,
      dictionarySymbols: symbols.length,
      commonSymbols: commonPairs.length,
      semanticStatePairs,
      groupStatePairs,
      groupDeltaPairs,
      rawConfigBytes: Number(options.rawConfigBytes || 0),
      concurrency: Number(options.concurrency || 0),
      nativeParitySamples: Number(options.nativeParitySamples || 0),
      reconstructionMismatches: 0,
      generationMs: Number(options.generationMs || 0),
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!key || !argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error(`invalid argument near ${argv[index] || '(end)'}`);
    }
    args[key] = argv[index + 1];
  }
  return args;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function visibleProfileKeys(outDir, slug) {
  const catalogPath = join(outDir, `${slug}.json.gz`);
  if (!existsSync(catalogPath)) throw new Error(`missing verified Catalog asset: ${catalogPath}`);
  const catalog = JSON.parse(gunzipSync(readFileSync(catalogPath)).toString('utf8'));
  return new Set((catalog.targets || []).flatMap((target) =>
    (target.profiles || []).filter((profile) => profile.selectable !== false)
      .map((profile) => `${target.id}\0${profile.id}`)));
}

function snapshotFile(path) {
  return existsSync(path) ? { exists: true, data: readFileSync(path) } : { exists: false, data: null };
}

function restoreFile(path, snapshot) {
  if (snapshot.exists) writeFileSync(path, snapshot.data);
  else rmSync(path, { force: true });
}

function targetOverrideSampleIndexes(rows, targetOverrides) {
  const targets = new Set((targetOverrides || []).map(([target]) => target));
  const firstByTarget = new Map();
  rows.forEach((row, index) => {
    if (targets.has(row.target.id) && !firstByTarget.has(row.target.id)) firstByTarget.set(row.target.id, index);
  });
  return [...firstByTarget.values()];
}

export function makeParityIndexes(rows, aliases = [], overrides = [], targetOverrides = []) {
  const count = rows.length;
  if (!count) return [];
  const spread = [0, Math.floor((count - 1) / 4), Math.floor((count - 1) / 2),
    Math.floor(((count - 1) * 3) / 4), count - 1];
  return [...new Set([
    ...spread,
    ...aliases.flatMap((pair) => pair),
    ...overrides.map((pair) => pair[0]),
    ...targetOverrideSampleIndexes(rows, targetOverrides),
  ])].filter((index) => index >= 0 && index < count).sort((a, b) => a - b);
}

export function verifyMakeDefconfigParity(tree, rows, aliases, overrides, targetOverrides,
  indexes = makeParityIndexes(rows, aliases, overrides, targetOverrides)) {
  const configPath = join(tree, '.config');
  const oldConfigPath = join(tree, '.config.old');
  const originalConfig = snapshotFile(configPath);
  const originalOldConfig = snapshotFile(oldConfigPath);
  const makeEnv = { ...process.env };
  delete makeEnv.KCONFIG_CONFIG;
  delete makeEnv.KCONFIG_OVERWRITECONFIG;
  try {
    for (const index of indexes) {
      const row = rows[index];
      const started = Date.now();
      console.log(`E make defconfig start: ${row.target.id}/${row.profile.id}`);
      writeFileSync(configPath, buildProfileSeed(row.target, row.profile, row.selectors));
      rmSync(oldConfigPath, { force: true });
      execFileSync('make', ['-C', tree, 'defconfig'], {
        stdio: 'pipe', encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: makeEnv,
      });
      const makeValues = parseConfigSymbols(readFileSync(configPath, 'utf8'));
      const parity = compareConfigSemantics(row.values, makeValues);
      if (!parity.equal) {
        throw new Error(`Native resolver differs from make defconfig for ${row.target.id}/${row.profile.id}: ` +
          JSON.stringify(parity.differences.slice(0, 20)));
      }
      console.log(`E make defconfig parity: ${row.target.id}/${row.profile.id} OK (${parity.leftHash}) / ${Date.now() - started} ms`);
    }
  } finally {
    restoreFile(configPath, originalConfig);
    restoreFile(oldConfigPath, originalOldConfig);
  }
  return indexes.length;
}

export function loadNativeProfileEntries(tree, outDir, slug) {
  const visible = visibleProfileKeys(outDir, slug);
  if (!visible.size) throw new Error(`no verified selectable Profile for ${slug}`);

  const targets = parseInfoRecords(readFileSync(join(tree, 'tmp', '.targetinfo'), 'utf8'));
  const menu = parseKconfigTree(tree);
  const kconfigSymbols = new Set((menu.allOptions || menu.options || []).map((option) => option.symbol));
  for (const target of targets) target.contract = targetBuildContract(target, kconfigSymbols);
  const entries = targets.flatMap((target) => (target.profiles || [])
    .filter((profile) => visible.has(`${target.id}\0${profile.id}`))
    .map((profile) => ({ target, profile, selectors: resolveTargetSelectors(target, profile, kconfigSymbols) })));
  if (entries.length !== visible.size) throw new Error(`verified Profile identity mismatch: catalog=${visible.size}, targetinfo=${entries.length}`);
  return entries;
}

export function prepareNativeProfileResolver(tree) {
  execFileSync('make', ['-C', tree, 'scripts/config/conf'], { stdio: 'inherit' });
  const conf = join(tree, 'scripts', 'config', 'conf');
  if (!existsSync(conf)) throw new Error(`upstream Kconfig resolver is unavailable: ${conf}`);
}

export async function generateNativeProfileRows(tree, entries, workDir, jobs) {
  const conf = join(tree, 'scripts', 'config', 'conf');
  console.log(`E Native Profile workers: ${jobs}`);
  mkdirSync(workDir, { recursive: true });
  try {
    let completed = 0;
    const nativeStarted = Date.now();
    const rows = await mapConcurrentOrdered(entries, async (entry, index) => {
      const configPath = join(workDir,
        `${String(index).padStart(6, '0')}--${safeSlug(entry.target.id)}--${safeSlug(entry.profile.id)}.config`);
      writeFileSync(configPath, buildProfileSeed(entry.target, entry.profile, entry.selectors));
      await execFileAsync(conf, [`--defconfig=${configPath}`, '-w', configPath, 'Config.in'], {
        cwd: tree, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, KCONFIG_CONFIG: configPath, KCONFIG_OVERWRITECONFIG: '1' },
      });
      const text = readFileSync(configPath, 'utf8');
      const values = parseConfigSymbols(text);
      if (!values.size) throw new Error(`Native conf produced an empty config: ${entry.target.id}/${entry.profile.id}`);
      completed += 1;
      if (completed % 100 === 0 || completed === entries.length) console.log(`E Native Profile config: ${completed}/${entries.length}`);
      return { ...entry, values, rawBytes: statSync(configPath).size };
    }, jobs);

    const nativeConfigMs = Date.now() - nativeStarted;
    const nativeProfilesPerSecond = nativeConfigMs > 0 ? (rows.length * 1000) / nativeConfigMs : rows.length;
    console.log(`E Native Profile throughput: ${rows.length} profiles / ${nativeConfigMs} ms / ${nativeProfilesPerSecond.toFixed(2)} profiles/s`);

    return { rows, nativeConfigMs };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function writeProfileGroupAssets(payload, meta, outDir, slug) {
  const metaPath = join(outDir, `${slug}.meta.json`);
  const rawConfigBytes = payload.metrics.rawConfigBytes;
  const json = JSON.stringify(payload);
  const compressed = gzipSync(Buffer.from(json), { level: 9 });
  const asset = `${slug}.profiles.json.gz`;
  writeFileSync(join(outDir, asset), compressed);

  meta.assets ||= {};
  meta.assets.profileBaselines = {
    asset, hash: sha256(compressed), bytes: compressed.byteLength,
    sha256: sha256(Buffer.from(json)), jsonBytes: Buffer.byteLength(json),
    schema: payload.schema, encoding: payload.encoding, profiles: payload.profiles.length,
    configGroups: payload.groups.length, targetIdentityOverrides: payload.identity.targetOverrides.length,
    identityAliases: payload.identity.aliases.length, identityOverrides: payload.identity.overrides.length,
    commonSymbols: payload.metrics.commonSymbols, dictionarySymbols: payload.symbols.length,
  };
  meta.sizeReport ||= {};
  meta.sizeReport.profileBaselines = {
    bytes: compressed.byteLength, jsonBytes: Buffer.byteLength(json), rawConfigBytes,
    profiles: payload.profiles.length, configGroups: payload.groups.length,
    averageCompressedBytesPerProfile: payload.profiles.length ? Math.round(compressed.byteLength / payload.profiles.length) : 0,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`E Profile Config Groups: ${payload.profiles.length} profiles -> ${payload.groups.length} exact groups / ` +
    `${payload.identity.targetOverrides.length} target identity overrides / ${payload.identity.aliases.length} identity aliases / ` +
    `${payload.identity.overrides.length} profile identity overrides / ${compressed.byteLength} compressed bytes / ` +
    `${payload.metrics.nativeParitySamples} make defconfig parity samples / ${payload.metrics.generationMs} ms total`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ['tree', 'source-id', 'branch', 'out']) if (!args[key]) throw new Error(`Missing --${key}`);
  const started = Date.now();
  const tree = resolve(args.tree);
  const outDir = resolve(args.out);
  const slug = `${safeSlug(args['source-id'])}--${safeSlug(args.branch)}`;
  const metaPath = join(outDir, `${slug}.meta.json`);
  if (!existsSync(metaPath)) throw new Error(`missing Catalog meta: ${metaPath}`);
  const entries = loadNativeProfileEntries(tree, outDir, slug);
  prepareNativeProfileResolver(tree);
  const jobs = Math.max(1, Math.min(entries.length, normalizeProfileGroupJobs(args.jobs || process.env.PROFILE_GROUP_JOBS)));
  const { rows, nativeConfigMs } = await generateNativeProfileRows(tree, entries,
    join(outDir, `.profile-group-work-${process.pid}`), jobs);
  let commit = '';
  try { commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  const rawConfigBytes = rows.reduce((sum, row) => sum + row.rawBytes, 0);
  const payload = buildProfileGroupDocument(rows, { id: args['source-id'], branch: args.branch, commit }, {
    rawConfigBytes, concurrency: jobs,
  });
  const nativeParitySamples = verifyMakeDefconfigParity(
    tree, rows, payload.identity.aliases, payload.identity.overrides, payload.identity.targetOverrides,
  );
  payload.generatedAt = new Date().toISOString();
  payload.metrics.nativeParitySamples = nativeParitySamples;
  payload.metrics.generationMs = Date.now() - started;
  payload.metrics.nativeConfigMs = nativeConfigMs;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.buildInputs) {
    const inputsHash = catalogInputsHash(captureCatalogInputs(tree));
    if (inputsHash !== meta.source.inputsHash) throw new Error('Profile generation inputs changed after graph generation');
    payload.source.inputsHash = inputsHash;
  }
  writeProfileGroupAssets(payload, meta, outDir, slug);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
