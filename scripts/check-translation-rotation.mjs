#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const translator = join(ROOT, 'scripts', 'translate-catalog.mjs');
const fakeArgos = join(ROOT, 'scripts', 'test-argos.py');
const slowArgos = join(ROOT, 'tests', 'slow-argos.py');
const temp = mkdtempSync(join(tmpdir(), 'weig-catalog-translation-'));
const dist = join(temp, 'dist');
const previous = join(temp, 'previous');
mkdirSync(dist);
mkdirSync(previous);
const catalogFile = join(dist, 'immortalwrt--openwrt-25.12.json.gz');
const languageFile = join(dist, 'immortalwrt--openwrt-25.12.menu.zh-cn.json.gz');
const writeIndex = (directory, legacyAsset, languageAsset) => {
  writeFileSync(join(directory, 'index.json'), JSON.stringify({
    schema: 2,
    sources: [{ id: 'ImmortalWrt', branches: [{
      branch: 'openwrt-25.12',
      legacy: { asset: legacyAsset },
      assets: { 'menu:zh-CN': { asset: languageAsset } },
    }] }],
  }));
  writeFileSync(join(directory, languageAsset), gzipSync(Buffer.from('{}')));
};
writeIndex(dist, 'immortalwrt--openwrt-25.12.json.gz', 'immortalwrt--openwrt-25.12.menu.zh-cn.json.gz');
writeFileSync(catalogFile, gzipSync(Buffer.from(JSON.stringify({
  source: { id: 'ImmortalWrt', branch: 'openwrt-25.12' },
  menu: {
    options: [
      { symbol: 'PACKAGE_alpha', promptEn: 'alpha', usageEn: 'Alpha package description.' },
      { symbol: 'PACKAGE_beta', promptEn: 'beta', usageEn: 'Beta package description.' },
    ],
    labels: {},
    choices: [],
  },
}))));

let requestCount = 0;
const server = createServer(async (request, response) => {
  requestCount += 1;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const target = new URL(request.url, 'http://127.0.0.1').searchParams.get('to');
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(rows.map((row) => ({
    translations: [{ to: target, text: `${target}:${row.Text}` }],
  }))));
});

const run = (trigger, provider = 'argos', extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    translator, dist, join(previous, 'i18n-cache.json'),
  ], {
    env: {
      ...process.env,
      AZURE_TRANSLATOR_KEY: 'fixture-key',
      AZURE_TRANSLATOR_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
      TRANSLATION_PROVIDER: provider,
      ARGOS_TRANSLATOR_SCRIPT: fakeArgos,
      TRANSLATE_TRIGGER: trigger,
      TRANSLATE_LANGUAGE: 'auto',
      TRANSLATE_CHAR_BUDGET: '10000',
      TRANSLATE_MONTHLY_BUDGET: '100000',
      ...extraEnv,
    },
  });
  let output = '';
  child.stdout.on('data', (value) => { output += value; });
  child.stderr.on('data', (value) => { output += value; });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await run('schedule');
  let summary = JSON.parse(readFileSync(join(dist, 'translation-summary.json'), 'utf8'));
  let state = JSON.parse(readFileSync(join(dist, 'translation-state.json'), 'utf8'));
  let catalog = JSON.parse(gunzipSync(readFileSync(catalogFile)));
  assert.equal(summary.activeLanguage, 'zh-CN');
  assert.equal(summary.translatedThisRun, 2);
  assert.equal(summary.nextLanguage, 'ru');
  assert.equal(state.phase, 'rotation');
  assert.equal(catalog.menu.options[0].promptI18n?.['zh-CN'], undefined);
  assert.match(catalog.menu.options[0].usageI18n['zh-CN'], /^argos:/);
  const languageCatalog = JSON.parse(gunzipSync(readFileSync(languageFile)));
  assert.equal(languageCatalog.kind, 'menu-language');
  assert.match(languageCatalog.options.find((row) => row[0] === 'PACKAGE_alpha')[2], /^argos:/);
  assert.equal(summary.provider, 'argos');
  assert.equal(summary.model, 'fixture-en-target');
  assert.equal(catalog.menu.options[0].usageI18n?.['zh-TW'], undefined);

  copyFileSync(join(dist, 'i18n-cache.json'), join(previous, 'i18n-cache.json'));
  copyFileSync(join(dist, 'translation-state.json'), join(previous, 'translation-state.json'));
  await run('schedule', 'argos', { TRANSLATE_BATCH_NUMBER: '2', TRANSLATE_BATCH_COUNT: '3', TRANSLATE_MAX_ITEMS: '100' });
  summary = JSON.parse(readFileSync(join(dist, 'translation-summary.json'), 'utf8'));
  state = JSON.parse(readFileSync(join(dist, 'translation-state.json'), 'utf8'));
  assert.equal(summary.activeLanguage, 'ru');
  assert.equal(summary.nextLanguage, 'es');
  assert.equal(summary.batchNumber, 2);
  assert.equal(summary.batchCount, 3);
  assert.equal(summary.batchLimit, 100);
  assert.equal(state.rotationIndex, 1);

  copyFileSync(join(dist, 'i18n-cache.json'), join(previous, 'i18n-cache.json'));
  copyFileSync(join(dist, 'translation-state.json'), join(previous, 'translation-state.json'));
  const requestsBeforePush = requestCount;
  await run('push', 'off');
  summary = JSON.parse(readFileSync(join(dist, 'translation-summary.json'), 'utf8'));
  state = JSON.parse(readFileSync(join(dist, 'translation-state.json'), 'utf8'));
  assert.equal(requestCount, requestsBeforePush);
  assert.equal(summary.translatedThisRun, 0);
  assert.equal(state.rotationIndex, 1);
  const cancelDist = join(temp, 'cancel-dist');
  mkdirSync(cancelDist);
  writeIndex(cancelDist, 'immortalwrt--openwrt-25.12.json.gz', 'immortalwrt--openwrt-25.12.menu.zh-cn.json.gz');
  writeFileSync(join(cancelDist, 'immortalwrt--openwrt-25.12.json.gz'), gzipSync(Buffer.from(JSON.stringify({
    menu: { options: [{ symbol: 'PACKAGE_cancel', promptEn: 'cancel', usageEn: 'Cancel fixture.' }], labels: {}, choices: [] },
  }))));
  const cancelled = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [translator, cancelDist, join(temp, 'cancel-cache.json')], {
      env: { ...process.env, TRANSLATION_PROVIDER: 'argos', TRANSLATE_ENABLED: 'true',
        TRANSLATE_TRIGGER: 'manual', ARGOS_TRANSLATOR_SCRIPT: slowArgos },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const fallbackCancel = setTimeout(() => child.kill('SIGTERM'), 2000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('slow Argos fixture started')) child.kill('SIGTERM');
    });
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(fallbackCancel); resolve(code); });
  });
  assert.notEqual(cancelled, 0);
  assert.equal(JSON.parse(readFileSync(join(cancelDist, 'translation-summary.json'), 'utf8')).status, 'running',
    'an interrupted batch must retain an incomplete receipt, never a completed report');
  console.log('translation rotation checks passed: zh-CN usage -> ru -> es; push uses cache only');
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
