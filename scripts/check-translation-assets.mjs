#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  indexedTranslationCatalogs,
  menuLanguagePayload,
  writeIndexedLanguageAssets,
} from './translation-catalog-assets.mjs';
import {
  synchronizeTranslationIndex,
  translationSparsePaths,
} from './translation-index-assets.mjs';

const directory = mkdtempSync(join(tmpdir(), 'catalog-translation-'));
try {
  const legacyAsset = 'future--openwrt-30.00.json.gz';
  const languageAsset = 'future--openwrt-30.00.menu.zh-cn.json.gz';
  const catalog = {
    schema: 5,
    source: { id: 'Future', branch: 'openwrt-30.00' },
    menu: {
      options: [{
        symbol: 'PACKAGE_demo',
        promptZh: '演示插件',
        usageZh: '中文插件说明',
        promptI18n: { de: 'Demo-Paket' },
        usageI18n: { de: 'Deutsche Beschreibung' },
      }],
      labels: { LuCI: { zhCN: '网页界面', usageZh: '网页配置', i18n: {}, usageI18n: {} } },
      choices: [{ id: 'choice-1', promptZh: '选择', usageZh: '请选择', promptI18n: {}, usageI18n: {} }],
    },
  };
  writeFileSync(join(directory, legacyAsset), gzipSync(Buffer.from(JSON.stringify(catalog))));
  writeFileSync(join(directory, languageAsset), gzipSync(Buffer.from('{}')));
  const index = {
    schema: 2,
    sources: [{
      id: 'Future',
      branches: [{
        id: '30.00',
        branch: 'openwrt-30.00',
        legacy: { asset: legacyAsset },
        assets: { 'menu:zh-CN': { asset: languageAsset } },
      }],
    }],
  };
  const entries = indexedTranslationCatalogs(index, directory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'Future');
  assert.equal(entries[0].branch, 'openwrt-30.00');
  assert.equal(entries[0].name, legacyAsset);
  assert.deepEqual(Object.keys(entries[0].languageAssets), ['zh-CN']);

  const payload = menuLanguagePayload(catalog, 'zh-CN', '2026-08-10T00:00:00.000Z');
  assert.deepEqual(payload.options, [['PACKAGE_demo', '演示插件', '中文插件说明']]);
  assert.deepEqual(payload.labels, [['LuCI', '网页界面', '网页配置']]);
  assert.deepEqual(payload.choices, [['choice-1', '选择', '请选择']]);
  assert.deepEqual(menuLanguagePayload(catalog, 'de', '2026-08-10T00:00:00.000Z').options,
    [['PACKAGE_demo', 'Demo-Paket', 'Deutsche Beschreibung']]);

  assert.equal(writeIndexedLanguageAssets(entries[0], catalog, '2026-08-10T00:00:00.000Z'), 1);
  const written = JSON.parse(gunzipSync(readFileSync(join(directory, languageAsset))));
  assert.equal(written.kind, 'menu-language');
  assert.equal(written.language, 'zh-CN');
  assert.deepEqual(written.options, payload.options);
  assert.equal(writeIndexedLanguageAssets(entries[0], catalog, '2026-08-11T00:00:00.000Z'), 0);
  const sparsePaths = translationSparsePaths(index);
  assert(sparsePaths.includes(`/${legacyAsset}`));
  assert(sparsePaths.includes(`/${languageAsset}`));
  assert(sparsePaths.includes('/future--openwrt-30.00.translations.json'));
  assert(!sparsePaths.some((file) => file.includes('.core.') || file.includes('.graph.')));
  const synchronized = synchronizeTranslationIndex(index, directory);
  assert.equal(synchronized.changed, true);
  assert.match(index.sources[0].branches[0].assets['menu:zh-CN'].sha256, /^[a-f0-9]{64}$/);
  assert(index.sources[0].branches[0].assets['menu:zh-CN'].jsonBytes > 0);
  assert.equal(synchronizeTranslationIndex(index, directory, { check: true }).changed, false);

  assert.throws(() => indexedTranslationCatalogs({ schema: 2, sources: [{
    id: 'Future', branches: [{ branch: 'openwrt-31.00', legacy: { asset: 'missing.json.gz' } }],
  }] }, directory), /indexed translation asset is missing/);
  console.log('translation asset checks passed');
  // Many full legacy graphs must fit in a bounded heap: only one branch is
  // decoded at a time. Translation must preserve all non-text payloads.
  const bulky = { ...catalog, relations: { payload: 'x'.repeat(4 * 1024 * 1024) } };
  const branches = [];
  for (let i = 0; i < 24; i++) {
    const asset = `fixture-${i}.json.gz`;
    writeFileSync(join(directory, asset), gzipSync(Buffer.from(JSON.stringify(bulky))));
    branches.push({ branch: `fixture-${i}`, legacy: { asset }, assets: {} });
  }
  writeFileSync(join(directory, 'index.json'), JSON.stringify({ schema: 2, sources: [{ id: 'Fixture', branches }] }));
  execFileSync(process.execPath, ['--max-old-space-size=96',
    fileURLToPath(new URL('./translate-catalog.mjs', import.meta.url)), directory,
    join(directory, 'previous-cache.json')], {
    env: { ...process.env, TRANSLATION_PROVIDER: 'off', TRANSLATE_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const translated = JSON.parse(gunzipSync(readFileSync(join(directory, branches[0].legacy.asset))));
  assert.deepEqual(translated.relations, bulky.relations);
  assert.equal(JSON.parse(readFileSync(join(directory, 'translation-summary.json'))).status, 'completed');
  console.log('translation bounded-heap regression passed: 24 branches / 96 MiB heap');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
