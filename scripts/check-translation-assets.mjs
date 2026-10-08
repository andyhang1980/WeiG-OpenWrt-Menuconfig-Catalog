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
  readIndexedTranslationCatalog,
  writeTranslatedLegacyProjection,
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
  assert(!sparsePaths.includes('/future--openwrt-30.00.translations.json'),
    'producer reports must not be loaded or republished by translation');
  assert(!sparsePaths.some((file) => file.includes('.core.') || file.includes('.graph.')));
  const synchronized = synchronizeTranslationIndex(index, directory);
  assert.equal(synchronized.changed, true);
  assert.match(index.sources[0].branches[0].assets['menu:zh-CN'].sha256, /^[a-f0-9]{64}$/);
  assert(index.sources[0].branches[0].assets['menu:zh-CN'].jsonBytes > 0);
  assert.equal(synchronizeTranslationIndex(index, directory, { check: true }).changed, false);

  const textCatalog = { ...structuredClone(catalog), relations: { mustNotChange: ['y', 'm', 'n'] } };
  Object.assign(textCatalog.menu.options[0], { prompt: 'Demo', promptEn: 'Demo',
    usageEn: 'Full option text\nwith a second line.', type: 'tristate', depends: 'GATE' });
  Object.assign(textCatalog.menu.labels.LuCI, { en: 'LuCI', usageEn: 'Full label text, not a summary.' });
  Object.assign(textCatalog.menu.choices[0], { promptEn: 'Choice', usageEn: 'Full choice text, not a summary.' });
  writeFileSync(join(directory, legacyAsset), gzipSync(Buffer.from(JSON.stringify(textCatalog))));
  const menuFile = join(directory, 'future--openwrt-30.00.menu.json.gz');
  const helpFile = join(directory, 'future--openwrt-30.00.help.json.gz');
  writeFileSync(menuFile, gzipSync(Buffer.from(JSON.stringify({ kind: 'menu', source: textCatalog.source,
    options: [{ symbol: 'PACKAGE_demo', prompt: 'Demo', promptEn: 'Demo', usageEn: 'Truncated summary' }],
  }))));
  const fullText = { kind: 'help', source: textCatalog.source, translationInput: 'complete-text-v1',
    options: [{ symbol: 'PACKAGE_demo', en: textCatalog.menu.options[0].usageEn,
      promptZh: textCatalog.menu.options[0].promptZh, promptI18n: textCatalog.menu.options[0].promptI18n,
      zhCN: textCatalog.menu.options[0].usageZh, i18n: textCatalog.menu.options[0].usageI18n }],
    labels: textCatalog.menu.labels, choices: textCatalog.menu.choices };
  writeFileSync(helpFile, gzipSync(Buffer.from(JSON.stringify(fullText))));
  const modernEntry = { ...entries[0], textAssets: {
    menu: { file: menuFile }, help: { file: helpFile },
  } };
  const modern = readIndexedTranslationCatalog(modernEntry);
  assert.equal(modern.modern, true);
  assert.equal(modern.catalog.menu.options[0].usageEn, textCatalog.menu.options[0].usageEn);
  for (const language of ['zh-CN', 'de']) {
    assert.deepEqual(menuLanguagePayload(modern.catalog, language, 'same'), menuLanguagePayload(textCatalog, language, 'same'),
      'modern text-only input must preserve full source/manual titles, help, labels and choices');
  }
  modern.catalog.menu.options[0].usageI18n.de = 'Updated description';
  const legacyView = { catalog: structuredClone(textCatalog), modern: false,
    originalText: JSON.stringify(textCatalog) };
  legacyView.catalog.menu.options[0].usageI18n.de = 'Updated description';
  writeTranslatedLegacyProjection(modernEntry, modern, 'fixed-time');
  const modernOutput = JSON.parse(gunzipSync(readFileSync(join(directory, legacyAsset))));
  writeTranslatedLegacyProjection(entries[0], legacyView, 'fixed-time');
  assert.deepEqual(modernOutput, JSON.parse(gunzipSync(readFileSync(join(directory, legacyAsset)))),
    'modern and legacy translation projection must be fully equal, including untouched Kconfig graph');
  assert.deepEqual(modernOutput.relations, textCatalog.relations);
  assert.throws(() => readIndexedTranslationCatalog({ ...modernEntry, textAssets: {
    ...modernEntry.textAssets, menu: { file: menuFile, hash: 'bad', asset: 'menu' },
  } }), /text contract mismatch/, 'advertised corrupt text may not silently fall back');
  writeFileSync(helpFile, gzipSync(Buffer.from(JSON.stringify({ ...fullText, translationInput: undefined }))));
  assert.equal(readIndexedTranslationCatalog(modernEntry).modern, false,
    'older partial help projections must retain the legacy translation path');

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
