#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  indexedTranslationCatalogs,
  readTranslationIndex,
  writeIndexedLanguageAssets,
  readIndexedTranslationCatalog,
  writeTranslatedLegacyProjection,
} from './translation-catalog-assets.mjs';

const [distArg = 'dist', previousArg = 'previous/i18n-cache.json'] = process.argv.slice(2);
const distDir = resolve(distArg), previousFile = resolve(previousArg);
const previousStateFile = join(dirname(previousFile), 'translation-state.json');
const languages = ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'];
const rotationLanguages = ['ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'];
const frozenLanguages = ['zh-TW'];
const languageCodes = { 'zh-CN': 'zh-Hans', ru: 'ru', es: 'es', pt: 'pt', ja: 'ja', ko: 'ko', de: 'de', fr: 'fr', vi: 'vi' };
const trigger = process.env.TRANSLATE_TRIGGER || 'local';
const requestedLanguage = process.env.TRANSLATE_LANGUAGE || 'auto';
const provider = String(process.env.TRANSLATION_PROVIDER || 'argos').toLowerCase();
const enabled = provider !== 'off' && process.env.TRANSLATE_ENABLED !== 'false';
const azureKey = process.env.AZURE_TRANSLATOR_KEY || '';
const runBudget = Math.max(0, Number(process.env.TRANSLATE_CHAR_BUDGET || 400000));
const batchNumber = Math.max(1, Number(process.env.TRANSLATE_BATCH_NUMBER || 1));
const batchCount = Math.max(batchNumber, Number(process.env.TRANSLATE_BATCH_COUNT || 1));
const requestedMaxItems = Number(process.env.TRANSLATE_MAX_ITEMS || 500);
if (!Number.isInteger(requestedMaxItems) || requestedMaxItems < 100 || requestedMaxItems > 5000) {
  throw new Error('TRANSLATE_MAX_ITEMS must be an integer from 100 to 5000');
}
const maxItems = requestedMaxItems;
const azureEndpoint = String(process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com').replace(/\/+$/, '');
const cache = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : { schema: 1, entries: {} };
const state = existsSync(previousStateFile) ? JSON.parse(readFileSync(previousStateFile, 'utf8')) : { schema: 1, phase: 'zh-CN-usage', rotationIndex: 0 };
const retryFile = join(distDir, 'translation-retry-queue.json');
const retryQueue = existsSync(retryFile) ? JSON.parse(readFileSync(retryFile, 'utf8')) : { schema: 1, languages: {} };
let activeChild = null, cancelled = false, temporaryFiles = [];
process.once('exit', () => temporaryFiles.forEach((file) => rmSync(file, { force: true })));
const stopTranslation = (signal) => {
  cancelled = true;
  console.log(`Translation: ${signal} received; stopping Argos without publishing this batch...`);
  activeChild?.kill('SIGTERM');
  setTimeout(() => activeChild?.kill('SIGKILL'), 10000).unref();
};
process.once('SIGINT', () => stopTranslation('SIGINT'));
process.once('SIGTERM', () => stopTranslation('SIGTERM'));
if (!['argos', 'azure', 'off'].includes(provider)) throw new Error(`Unsupported translation provider: ${provider}`);
if (requestedLanguage !== 'auto' && requestedLanguage !== 'zh-CN' && !rotationLanguages.includes(requestedLanguage)) throw new Error(`Unsupported translation language: ${requestedLanguage}`);
cache.entries ||= {}; state.rotationIndex = Number(state.rotationIndex || 0) % rotationLanguages.length;
const hash = (kind, text) => createHash('sha256').update(`${kind}\0${text}`).digest('hex');
const clean = (map, english) => Object.fromEntries(languages.map((lang) => [lang, String(map?.[lang] || '').trim()]).filter(([, text]) => text && text !== english));
const fallback = (row) => row.symbol?.startsWith('PACKAGE_') ? `${row.promptEn || row.prompt || row.symbol} package for OpenWrt firmware.` : `OpenWrt configuration option: ${row.promptEn || row.prompt || row.symbol}.`;
// Keep only file descriptors across passes. A full Catalog includes the
// dependency graph, which must not stay resident while translating other branches.
const usage = [], seen = new Set();
const summaryFile = join(distDir, 'translation-summary.json');
writeFileSync(summaryFile, JSON.stringify({ status: 'running', provider, activeLanguage: requestedLanguage,
  batchNumber, batchCount, warning: 'Translation did not complete; inspect the first failing process log.' }) + '\n');
const catalogs = indexedTranslationCatalogs(readTranslationIndex(distDir), distDir);
const register = (kind, english, manual = {}) => {
  const text = String(english || '').trim(); if (!text) return {};
  const id = hash(kind, text), saved = cache.entries[id] || {};
  const translations = { ...saved.translations, ...clean(manual, text) };
  const translationMeta = { ...saved.translationMeta };
  for (const lang of Object.keys(clean(manual, text))) translationMeta[lang] ||= { provider: 'manual' };
  cache.entries[id] = { kind, english: text, translations, translationMeta };
  if (kind === 'usage' && !seen.has(id)) { seen.add(id); usage.push(id); }
  return translations;
};
for (const entry of catalogs) {
  const { catalog } = readIndexedTranslationCatalog(entry);
  for (const row of catalog.menu?.options || []) { row.usageEn ||= fallback(row); row.promptI18n = register('title', row.promptEn || row.prompt || row.symbol, row.promptI18n); row.usageI18n = register('usage', row.usageEn, row.usageI18n); }
  for (const row of Object.values(catalog.menu?.labels || {})) { row.i18n = register('title', row.en, { ...row.i18n, 'zh-CN': row.zhCN || row.i18n?.['zh-CN'] }); row.usageI18n = register('usage', row.usageEn, { ...row.usageI18n, 'zh-CN': row.usageZh || row.usageI18n?.['zh-CN'] }); }
  for (const row of catalog.menu?.choices || []) { row.promptI18n = register('title', row.promptEn || row.prompt, { ...row.promptI18n, 'zh-CN': row.promptZh || row.promptI18n?.['zh-CN'] }); row.usageI18n = register('usage', row.usageEn, { ...row.usageI18n, 'zh-CN': row.usageZh || row.usageI18n?.['zh-CN'] }); }
}
const missing = (lang) => usage.filter((id) => !cache.entries[id]?.translations?.[lang]);
const zhBefore = missing('zh-CN').length;
if (zhBefore) state.phase = 'zh-CN-usage'; else if (state.phase !== 'rotation') state.phase = 'rotation';
const runPhase = state.phase;
const activeLanguage = requestedLanguage !== 'auto' ? requestedLanguage : runPhase === 'zh-CN-usage' ? 'zh-CN' : rotationLanguages[state.rotationIndex];
const retryIds = new Set((retryQueue.languages?.[activeLanguage] || []).map((row) => row.id));
const candidates = missing(activeLanguage).map((id) => [id, cache.entries[id]]).filter(([, row]) => [...row.english].length <= 4500)
  .sort((a, b) => Number(retryIds.has(b[0])) - Number(retryIds.has(a[0])));
const pending = []; let chars = 0;
for (const row of candidates) { const length = [...row[1].english].length; if (pending.length >= maxItems || (provider === 'azure' && chars + length > runBudget)) continue; pending.push(row); chars += length; }
let translated = 0, requestedCharacters = 0, apiError = '', model = '', rejected = 0, timedOut = false;
const save = (id, text, meta) => { const row = cache.entries[id]; if (!row || !text || text === row.english || row.translations[activeLanguage]) return; row.translations[activeLanguage] = text; row.translationMeta ||= {}; row.translationMeta[activeLanguage] = { provider, model: meta, translatedAt: new Date().toISOString() }; translated += 1; };
if (enabled && provider === 'azure') {
  if (!azureKey) apiError = 'Azure selected but AZURE_TRANSLATOR_KEY is not configured';
  for (let offset = 0; azureKey && offset < pending.length && !apiError;) {
    const batch = pending.slice(offset, offset + 50); offset += batch.length; requestedCharacters += batch.reduce((sum, [, row]) => sum + [...row.english].length, 0);
    try { const query = new URLSearchParams({ 'api-version': '3.0', from: 'en', textType: 'plain', to: languageCodes[activeLanguage] }); const headers = { 'Ocp-Apim-Subscription-Key': azureKey, 'Content-Type': 'application/json' }; if (process.env.AZURE_TRANSLATOR_REGION) headers['Ocp-Apim-Subscription-Region'] = process.env.AZURE_TRANSLATOR_REGION; const response = await fetch(`${azureEndpoint}/translate?${query}`, { method: 'POST', headers, body: JSON.stringify(batch.map(([, row]) => ({ Text: row.english }))) }); if (!response.ok) throw new Error(`${response.status} ${await response.text()}`); const payload = await response.json(); batch.forEach(([id], index) => save(id, String(payload[index]?.translations?.[0]?.text || '').trim(), 'azure-translator')); model = 'azure-translator'; } catch (error) { apiError = error.message; }
  }
}
if (enabled && provider === 'argos' && pending.length) {
  const queue = join(distDir, '.argos-queue.json'), resultFile = join(distDir, '.argos-result.json');
  temporaryFiles = [queue, resultFile];
  writeFileSync(queue, JSON.stringify({ language: activeLanguage, timeBudgetSeconds: Number(process.env.ARGOS_TIME_BUDGET_SECONDS || 3000), rows: pending.map(([id, row]) => ({ id, text: row.english })) }));
  console.log(`Argos: ${activeLanguage}, batch ${batchNumber}/${batchCount}, queued ${pending.length}/${candidates.length} descriptions (batch limit ${maxItems})`);
  const result = await new Promise((done) => {
    activeChild = spawn(process.env.ARGOS_PYTHON || 'python', [process.env.ARGOS_TRANSLATOR_SCRIPT || join('scripts', 'translate-argos.py'), queue, resultFile], { stdio: 'inherit' });
    activeChild.once('error', (error) => done({ error, status: -1 }));
    activeChild.once('exit', (status) => done({ status }));
  });
  activeChild = null;
  if (cancelled) {
    rmSync(queue, { force: true }); rmSync(resultFile, { force: true }); temporaryFiles = [];
    throw new Error('Translation cancelled before Catalog data publish');
  }
  if (result.error || result.status !== 0 || !existsSync(resultFile)) apiError = result.error?.message || 'Argos translator failed';
  else { const output = JSON.parse(readFileSync(resultFile, 'utf8')); apiError = output.error || ''; model = output.model || 'argos'; rejected = Number(output.rejected || 0); timedOut = Boolean(output.timedOut); for (const row of output.translations || []) save(row.id, String(row.text || '').trim(), model); }
  rmSync(queue, { force: true }); rmSync(resultFile, { force: true }); temporaryFiles = [];
}
const incomplete = enabled && pending.length > 0 && translated !== pending.length;
const warning = apiError || (incomplete ? `Batch incomplete: translated ${translated}/${pending.length} queued descriptions` : '');
const fatalError = Boolean(enabled && pending.length > 0 && translated === 0);
const fatalMessage = fatalError ? (apiError || 'No translations produced') : '';
const ready = enabled && !fatalError && (provider !== 'azure' || Boolean(azureKey));
if (enabled) {
  retryQueue.schema = 1;
  retryQueue.updatedAt = new Date().toISOString();
  retryQueue.languages ||= {};
  const remaining = pending.filter(([id]) => !cache.entries[id]?.translations?.[activeLanguage])
    .map(([id, row]) => ({ id, text: row.english, reason: warning || 'not translated' }));
  if (remaining.length) retryQueue.languages[activeLanguage] = remaining;
  else delete retryQueue.languages[activeLanguage];
  writeFileSync(retryFile, JSON.stringify(retryQueue, null, 2) + '\n');
}
if (missing('zh-CN').length === 0) state.phase = 'rotation';
if (trigger === 'schedule' && state.phase === 'rotation' && runPhase === 'rotation' && ready && !incomplete && (translated || !pending.length)) state.rotationIndex = (state.rotationIndex + 1) % rotationLanguages.length;
const nextLanguage = state.phase === 'zh-CN-usage' ? 'zh-CN' : rotationLanguages[state.rotationIndex];
if (enabled) { state.updatedAt = new Date().toISOString(); state.lastRun = { trigger, requestedLanguage, provider, activeLanguage, translated, requestedCharacters, model, apiError: fatalMessage, warning }; }
let localizedFields = 0, pendingFields = 0;
const localizedByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const pendingByLanguage = Object.fromEntries(languages.map((lang) => [lang, 0]));
const count = (translations) => languages.forEach((lang) => translations[lang] ? localizedByLanguage[lang]++ : pendingByLanguage[lang]++);
for (const entry of catalogs) {
  const view = readIndexedTranslationCatalog(entry);
  const { catalog } = view;
  for (const row of catalog.menu?.options || []) row.usageEn ||= fallback(row);
  for (const row of catalog.menu?.options || []) for (const [kind, english] of [['title', row.promptEn || row.prompt || row.symbol], ['usage', row.usageEn]]) { const translations = clean(cache.entries[hash(kind, String(english || '').trim())]?.translations, english); if (kind === 'title') row.promptI18n = translations; else row.usageI18n = translations; localizedFields += Object.keys(translations).length; pendingFields += languages.filter((lang) => !translations[lang]).length; count(translations); }
  for (const row of Object.values(catalog.menu?.labels || {})) { row.i18n = clean(cache.entries[hash('title', String(row.en || '').trim())]?.translations, row.en); row.usageI18n = clean(cache.entries[hash('usage', String(row.usageEn || '').trim())]?.translations, row.usageEn); count(row.i18n); count(row.usageI18n); }
  for (const row of catalog.menu?.choices || []) { const title = row.promptEn || row.prompt; row.promptI18n = clean(cache.entries[hash('title', String(title || '').trim())]?.translations, title); row.usageI18n = clean(cache.entries[hash('usage', String(row.usageEn || '').trim())]?.translations, row.usageEn); count(row.promptI18n); count(row.usageI18n); }
  const translationUpdatedAt = new Date().toISOString();
  writeTranslatedLegacyProjection(entry, view, translationUpdatedAt);
  writeIndexedLanguageAssets(entry, catalog, translationUpdatedAt);
}
cache.schema = 2; cache.updatedAt = new Date().toISOString();
writeFileSync(join(distDir, 'i18n-cache.json'), JSON.stringify(cache) + '\n'); writeFileSync(join(distDir, 'translation-state.json'), JSON.stringify(state, null, 2) + '\n');
const summary = { generatedAt: cache.updatedAt, catalogs: catalogs.length, cachedTexts: Object.keys(cache.entries).length, trigger, phase: state.phase, activeLanguage, nextLanguage, rotationLanguages, frozenLanguages, batchNumber, batchCount, queuedThisRun: pending.length, retryQueuedAfter: retryQueue.languages?.[activeLanguage]?.length || 0, batchLimit: maxItems, queuedCharacters: chars, requestedCharactersThisRun: requestedCharacters, runCharacterBudget: provider === 'azure' ? runBudget : null, translatedThisRun: translated, targetPendingBefore: candidates.length, targetPendingAfter: missing(activeLanguage).length, localizedFields, pendingFields, localizedByLanguage, pendingByLanguage, uniqueDescriptionPendingByLanguage: Object.fromEntries(languages.map((lang) => [lang, missing(lang).length])), provider, providerConfigured: provider === 'argos' ? !fatalError : provider === 'azure' ? Boolean(azureKey) : true, translationEnabled: enabled, model, rejected, timedOut, apiError: fatalMessage, warning };
writeFileSync(summaryFile, JSON.stringify({ ...summary, status: fatalError ? 'failed' : 'completed' }, null, 2) + '\n');
// One run summary/state is sufficient. Branch reports are producer diagnostics
// retained in Actions artifacts, not duplicated runtime publication payloads.
console.log(`translations: catalogs=${catalogs.length} cache=${Object.keys(cache.entries).length} provider=${provider} active=${activeLanguage} translated=${translated} next=${nextLanguage}${warning ? ` warning=${warning}` : ''}`);
if (enabled && fatalError) process.exitCode = 1;
