#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(ROOT, 'scripts/collect-results.mjs');
const temp = mkdtempSync(join(tmpdir(), 'weig-catalog-collector-'));

function addArtifact(root, order, branchName, status = 'success', {
  translation = true, contract = true, relations = true, duplicates = true, profileBaselines = true,
} = {}) {
  const orderText = String(order).padStart(2, '0');
  const artifact = `${orderText}-catalog-openwrt-${branchName}-run-1-attempt-1`;
  const base = join(root, 'current', artifact);
  const dist = join(base, 'dist');
  const attempts = join(base, 'attempts');
  const logs = join(base, 'failure-logs');
  mkdirSync(dist, { recursive: true });
  mkdirSync(attempts, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const asset = `openwrt--${branchName}.json.gz`;
  if (status === 'success') {
    const json = JSON.stringify({ schema: 5, source: 'OpenWrt', branch: branchName, generation: 'current' });
    const compressed = gzipSync(Buffer.from(json));
    writeFileSync(join(dist, asset), compressed);
    const shardValues = {
      core: { schema: 6, kind: 'core', source: { id: 'OpenWrt', branch: branchName } },
      graph: { schema: 6, kind: 'graph', source: { id: 'OpenWrt', branch: branchName }, relations: { schema: 3 } },
      menu: { schema: 1, kind: 'menu', options: [] },
      hidden: { schema: 1, kind: 'hidden', options: [] },
      help: { schema: 1, kind: 'help', options: [] },
      profileBaselines: {
        schema: 3,
        kind: 'profile-baselines',
        encoding: 'branch-common-plus-exact-config-groups-v1',
        source: { id: 'OpenWrt', branch: branchName },
        profileFields: ['target', 'board', 'subtarget', 'profile', 'name', 'boardSelector', 'selector', 'targetSelector', 'nativeHash', 'symbolCount', 'groupId'],
        stateGroups: ['n', 'm', 'y', 'otherIndexValue'],
        identity: { mode: 'catalog-target-tree-v1', fixed: [], targetOverrides: [], aliases: [], overrides: [] },
        symbols: ['FEATURE'],
        common: [[], [], [], []],
        groups: [[[], [], [0], []]],
        profiles: [['demo', 'demo', '', 'Default', 'Default', 'TARGET_demo', 'TARGET_demo_Default', 'TARGET_demo', 'a'.repeat(64), 1, 0]],
        metrics: { reconstructionMismatches: 0 },
      },
    };
    if (!profileBaselines) delete shardValues.profileBaselines;
    const assets = {};
    for (const [logical, value] of Object.entries(shardValues)) {
      const filename = `openwrt--${branchName}.${logical === 'profileBaselines' ? 'profiles' : logical}.json.gz`;
      const body = Buffer.from(JSON.stringify(value));
      const data = gzipSync(body);
      writeFileSync(join(dist, filename), data);
      assets[logical] = {
        logical, asset: filename,
        hash: createHash('sha256').update(data).digest('hex'),
        bytes: data.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        jsonBytes: body.byteLength,
        ...(logical === 'profileBaselines' ? {
          schema: value.schema,
          encoding: value.encoding,
          profiles: value.profiles.length,
          configGroups: value.groups.length,
        } : {}),
      };
    }
    writeFileSync(join(dist, `openwrt--${branchName}.meta.json`), JSON.stringify({
      schema: 6,
      source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branch: branchName },
      asset, sha256: createHash('sha256').update(json).digest('hex'),
      hash: createHash('sha256').update(compressed).digest('hex'), bytes: compressed.byteLength,
      legacy: {
        asset, hash: createHash('sha256').update(compressed).digest('hex'), bytes: compressed.byteLength,
        catalogSchema: 5, relationsSchema: 2,
      },
      assets,
    }));
    if (contract) {
      writeFileSync(join(dist, `openwrt--${branchName}.contract.json`), JSON.stringify({
        schema: 1,
        source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branch: branchName },
        summary: { selectableTargets: 1 },
        kconfigProbe: { targets: 1, passed: 1, quarantined: [] },
        unavailable: [],
      }));
    }
    if (relations) {
      const relationDocument = {
        schema: 3,
        source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt', branch: branchName },
        relations: { schema: 3, summary: { packages: 1 }, validation: { structurallyValid: true }, records: [] },
      };
      writeFileSync(join(dist, `openwrt--${branchName}.relations.json.gz`),
        gzipSync(Buffer.from(JSON.stringify(relationDocument))));
    }
    if (translation) writeFileSync(join(dist, `openwrt--${branchName}.translations.json`), '{}\n');
    if (duplicates) writeFileSync(join(dist, `openwrt--${branchName}.duplicates.json`), JSON.stringify({
      schema: 1, summary: { duplicateSymbols: 0, duplicateNodes: 0, conflicts: 0 }, duplicates: [], conflicts: [],
    }));
    writeFileSync(join(dist, `openwrt--${branchName}.curated-candidates.json`), JSON.stringify({
      schema: 1, curated: [], missing: [], applications: { count: 0, unique: 0, names: [] },
    }));
  }
  const failureLog = status === 'failure' ? `${orderText}-openwrt-${branchName}--clone.log` : '';
  writeFileSync(join(attempts, `${orderText}-openwrt-${branchName}.attempt.json`), JSON.stringify({
    schema: 2, order, orderText,
    jobName: `${orderText} · OpenWrt · ${branchName} · openwrt/openwrt`,
    source: { id: 'OpenWrt', label: 'OpenWrt', repo: 'openwrt/openwrt' },
    branch: branchName, version: branchName, status,
    stage: status === 'success' ? 'complete' : 'clone', artifactName: artifact, failureLog,
  }));
  writeFileSync(join(attempts, `${orderText}-openwrt-${branchName}--SUMMARY.txt`),
    `Source ID: OpenWrt\nBranch: ${branchName}\nFinal status: ${status}\n`);
  if (failureLog) writeFileSync(join(logs, failureLog), 'clone failed\n');
}

function fixture(name, setup) {
  const root = join(temp, name);
  const previous = join(root, 'previous');
  mkdirSync(previous, { recursive: true });
  setup(root, previous);
  return root;
}

function addPrevious(previous, branchName) {
  const json = JSON.stringify({ source: 'OpenWrt', branch: branchName, generation: 'previous' });
  writeFileSync(join(previous, `openwrt--${branchName}.json.gz`), gzipSync(Buffer.from(json)));
  writeFileSync(join(previous, `openwrt--${branchName}.translations.json`), '{"old":true}\n');
}

function run(root, shouldPass = true, refName = '') {
  const args = [
    script, join(root, 'current'), join(root, 'previous'), join(root, 'dist'),
    join(root, 'attempts'), join(root, 'diagnostics'),
  ];
  const env = { ...process.env };
  if (refName) env.GITHUB_REF_NAME = refName;
  else delete env.GITHUB_REF_NAME;
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  if (shouldPass && result.status !== 0) throw new Error(result.stderr || result.stdout);
  if (!shouldPass && result.status === 0) throw new Error('fatal Artifact fixture unexpectedly passed');
  if (!existsSync(join(root, 'diagnostics', 'publish-inputs.json'))) {
    throw new Error('collection did not preserve publish-inputs.json');
  }
  return JSON.parse(readFileSync(join(root, 'diagnostics', 'publish-inputs.json'), 'utf8'));
}

try {
  const valid = fixture('valid', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main');
  });
  const validManifest = run(valid);
  const validJson = JSON.parse(gunzipSync(readFileSync(
    join(valid, 'dist', 'openwrt--main.json.gz'))));
  if (!validManifest.complete || validManifest.fresh !== 1 ||
      validJson.generation !== 'current') throw new Error('valid current result was not published');
  for (const suffix of ['contract.json', 'relations.json.gz', 'duplicates.json', 'curated-candidates.json', 'translations.json']) {
    const name = `openwrt--main.${suffix}`;
    if (existsSync(join(valid, 'dist', name)) || !existsSync(join(valid, 'diagnostics', name))) {
      throw new Error(`diagnostic report must only be retained in Actions evidence: ${name}`);
    }
  }
  if (!existsSync(join(valid, 'dist', 'openwrt--main.graph.json.gz')) ||
      !existsSync(join(valid, 'dist', 'openwrt--main.profiles.json.gz'))) {
    throw new Error('runtime graph/Profile shards must remain published');
  }

  const fixValid = fixture('fix-valid', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main');
  });
  const fixValidManifest = run(fixValid, true, 'fix-F');
  if (!fixValidManifest.complete || fixValidManifest.fatalErrors.length) {
    throw new Error('complete fix snapshot was unexpectedly rejected');
  }

  const mixed = fixture('mixed', (root, previous) => {
    addPrevious(previous, 'main');
    addPrevious(previous, 'openwrt-24.10');
    addArtifact(root, 2, 'main');
    addArtifact(root, 3, 'openwrt-24.10', 'failure');
    addArtifact(root, 4, 'openwrt-25.12', 'failure');
  });
  const mixedManifest = run(mixed);
  const unavailable = mixedManifest.branches.find((item) => item.branch === 'openwrt-25.12');
  if (mixedManifest.complete || mixedManifest.fresh !== 1 || mixedManifest.lastGood !== 1 ||
      unavailable?.publishState !== 'unavailable') {
    throw new Error('partial success did not publish fresh plus last-good');
  }

  const fixMixed = fixture('fix-mixed', (root, previous) => {
    addPrevious(previous, 'main');
    addPrevious(previous, 'openwrt-24.10');
    addArtifact(root, 2, 'main');
    addArtifact(root, 3, 'openwrt-24.10', 'failure');
  });
  const fixMixedManifest = run(fixMixed, false, 'fix-F');
  if (!fixMixedManifest.fatalErrors.some((item) => item.includes('fail-closed'))) {
    throw new Error('incomplete fix snapshot was not fail-closed');
  }

  const profileless = fixture('profileless', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main', 'success', { profileBaselines: false });
  });
  const profilelessManifest = run(profileless);
  if (profilelessManifest.complete || profilelessManifest.fresh !== 0 ||
      !profilelessManifest.branches[0]?.issues.some((item) => item.includes('Profile baseline'))) {
    throw new Error('missing Native Profile baseline was not quarantined');
  }

  const quarantined = fixture('quarantined', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main', 'success', { translation: false });
  });
  const quarantineManifest = run(quarantined);
  const quarantineJson = JSON.parse(gunzipSync(readFileSync(
    join(quarantined, 'dist', 'openwrt--main.json.gz'))));
  if (quarantineManifest.complete || quarantineManifest.fresh !== 0 ||
       quarantineJson.generation !== 'previous') throw new Error('invalid current result overwrote last-good');

  const contractless = fixture('contractless', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main', 'success', { contract: false });
  });
  const contractlessManifest = run(contractless);
  if (contractlessManifest.complete || contractlessManifest.fresh !== 0 ||
      contractlessManifest.branches[0]?.issues.join(',') !== '缺 target contract') {
    throw new Error('missing target contract was not quarantined');
  }

  const relationless = fixture('relationless', (root, previous) => {
    addPrevious(previous, 'main');
    addArtifact(root, 2, 'main', 'success', { relations: false });
  });
  const relationlessManifest = run(relationless);
  if (relationlessManifest.complete || relationlessManifest.fresh !== 0 ||
      !relationlessManifest.branches[0]?.issues.includes('missing Kconfig relations')) {
    throw new Error('missing Kconfig relations were not quarantined');
  }

  const fatal = fixture('fatal', (root) => {
    mkdirSync(join(root, 'current'), { recursive: true });
  });
  run(fatal, false);
  console.log('catalog collector checks passed: fresh, partial, fix fail-closed, Profile baseline, quarantine, contract, relations, last-good, fatal');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
