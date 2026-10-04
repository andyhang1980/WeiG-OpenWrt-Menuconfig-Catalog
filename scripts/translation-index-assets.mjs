import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { branchLegacyContract, fileContract, indexContract } from './index-contract.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function translationSparsePaths(index) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.sources)) {
    throw new Error('index.json must contain a sources array');
  }
  const paths = new Set([
    '/index.json',
    '/i18n-cache.json',
    '/translation-state.json',
    '/translation-retry-queue.json',
    '/translation-summary.json',
  ]);
  for (const source of index.sources) {
    for (const branch of source.branches || []) {
      const legacy = branchLegacyContract(branch);
      if (legacy?.asset) {
        paths.add(`/${legacy.asset}`);
      }
      for (const [logical, contract] of Object.entries(branch.assets || {})) {
        if ((['menu', 'help'].includes(logical) || logical.startsWith('menu:')) && contract?.asset) paths.add(`/${contract.asset}`);
      }
    }
  }
  return [...paths].sort();
}

function fullContract(file) {
  const compressed = readFileSync(file);
  const json = gunzipSync(compressed);
  return {
    ...fileContract(file),
    sha256: sha256(json),
    jsonBytes: json.byteLength,
  };
}

export function synchronizeTranslationIndex(index, directory, { check = false } = {}) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.sources)) {
    throw new Error('index.json must contain a sources array');
  }
  const mismatches = [];
  for (const source of index.sources) {
    for (const branch of source.branches || []) {
      const legacy = branchLegacyContract(branch);
      if (!legacy?.asset) continue;
      const legacyFile = join(directory, legacy.asset);
      if (!existsSync(legacyFile)) throw new Error(`translation asset is missing: ${legacy.asset}`);
      const legacyActual = fileContract(legacyFile);
      if (legacy.hash !== legacyActual.hash || legacy.bytes !== legacyActual.bytes) {
        mismatches.push({ source: source.id, branch: branch.branch, logical: 'legacy', asset: legacy.asset });
        if (!check) {
          branch.legacy = { ...legacy, ...legacyActual };
          branch.asset = legacy.asset;
          branch.hash = legacyActual.hash;
          branch.bytes = legacyActual.bytes;
        }
      }
      for (const [logical, contract] of Object.entries(branch.assets || {})) {
        if (!logical.startsWith('menu:') || !contract?.asset) continue;
        const file = join(directory, contract.asset);
        if (!existsSync(file)) throw new Error(`translation asset is missing: ${contract.asset}`);
        const actual = fullContract(file);
        if (contract.hash !== actual.hash || Number(contract.bytes || 0) !== actual.bytes ||
            contract.sha256 !== actual.sha256 || Number(contract.jsonBytes || 0) !== actual.jsonBytes) {
          mismatches.push({ source: source.id, branch: branch.branch, logical, asset: contract.asset });
          if (!check) Object.assign(contract, actual);
        }
      }
    }
  }
  if (!check && mismatches.length) index.generatedAt = new Date().toISOString();
  const expectedIndex = indexContract(index);
  const indexMismatch = index.hash !== expectedIndex.hash || Number(index.bytes || 0) !== expectedIndex.bytes;
  if (!check) Object.assign(index, expectedIndex);
  return { mismatches, indexMismatch, changed: mismatches.length > 0 || indexMismatch };
}
