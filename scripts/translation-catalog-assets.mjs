import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const translationLanguages = [
  'zh-CN',
  'zh-TW',
  'ru',
  'es',
  'pt',
  'ja',
  'ko',
  'de',
  'fr',
  'vi',
];

export function indexedTranslationCatalogs(index, directory) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.sources)) {
    throw new Error('index.json must contain a sources array');
  }
  const rows = [];
  const seen = new Set();
  for (const source of index.sources) {
    for (const branch of source.branches || []) {
      const legacy = branch.legacy || branch;
      const asset = String(legacy?.asset || '');
      if (!asset || seen.has(asset)) continue;
      const file = join(directory, asset);
      if (!existsSync(file)) throw new Error(`indexed translation asset is missing: ${asset}`);
      seen.add(asset);
      const languageAssets = Object.fromEntries(Object.entries(branch.assets || {})
        .filter(([logical, contract]) => logical.startsWith('menu:') && contract?.asset)
        .map(([logical, contract]) => [logical.slice(5), join(directory, contract.asset)]));
      rows.push({
        source: String(source.id || ''),
        branch: String(branch.branch || branch.id || ''),
        name: asset,
        file,
        languageAssets,
        textAssets: Object.fromEntries(['menu', 'help'].filter((logical) => branch.assets?.[logical]?.asset)
          .map((logical) => [logical, { ...branch.assets[logical], file: join(directory, branch.assets[logical].asset) }])),
      });
    }
  }
  return rows;
}

export function readIndexedTranslationCatalog(entry) {
  const read = (contract) => {
    const bytes = readFileSync(contract.file);
    if ((contract.hash && createHash('sha256').update(bytes).digest('hex') !== contract.hash) ||
        (contract.bytes && bytes.length !== contract.bytes)) {
      throw new Error(`translation text contract mismatch: ${contract.asset}`);
    }
    return JSON.parse(gunzipSync(bytes));
  };
  if (entry.textAssets?.menu && entry.textAssets?.help) {
    const menu = read(entry.textAssets.menu);
    const help = read(entry.textAssets.help);
    if (help.translationInput === 'complete-text-v1') {
      if (menu.kind !== 'menu' || help.kind !== 'help' ||
          ['id', 'branch', 'commit'].some((key) => menu.source?.[key] !== help.source?.[key])) {
        throw new Error('translation menu/help identity mismatch');
      }
      const usage = new Map((help.options || []).map((row) => [row.symbol, row]));
      const catalog = { source: menu.source, menu: { ...menu,
        options: (menu.options || []).map((row) => {
          const full = usage.get(row.symbol);
          return { ...row, usageEn: full?.en || row.usageEn || '',
            promptZh: full?.promptZh || '', promptI18n: full?.promptI18n || {},
            usageZh: full?.zhCN || '', usageI18n: full?.i18n || {} };
        }), labels: structuredClone(help.labels || {}), choices: structuredClone(help.choices || []),
      } };
      const options = new Map(catalog.menu.options.map((row) => [row.symbol, row]));
      const choices = new Map(catalog.menu.choices.map((row) => [row.id, row]));
      for (const [language, file] of Object.entries(entry.languageAssets)) {
        const document = JSON.parse(gunzipSync(readFileSync(file)));
        const apply = (row, title, usageText, titleKey, usageKey) => {
          if (!row) return;
          // Keep the original manual Chinese fields and map spelling. A
          // language projection may derive Chinese from a separate field;
          // copying that back into the map would change legacy cache inputs.
          const chineseTitle = titleKey === 'i18n' ? row.zhCN : row.promptZh;
          if (title && (language !== 'zh-CN' || !chineseTitle)) (row[titleKey] ||= {})[language] = title;
          if (usageText && (language !== 'zh-CN' || !row.usageZh)) (row[usageKey] ||= {})[language] = usageText;
        };
        for (const [symbol, title, text] of document.options || []) apply(options.get(symbol), title, text, 'promptI18n', 'usageI18n');
        for (const [name, title, text] of document.labels || []) apply(catalog.menu.labels[name], title, text, 'i18n', 'usageI18n');
        for (const [id, title, text] of document.choices || []) apply(choices.get(id), title, text, 'promptI18n', 'usageI18n');
      }
      return { catalog, modern: true };
    }
  }
  const originalText = gunzipSync(readFileSync(entry.file)).toString('utf8');
  return { catalog: JSON.parse(originalText), originalText, modern: false };
}

export function writeTranslatedLegacyProjection(entry, view, generatedAt) {
  const originalText = view.originalText || gunzipSync(readFileSync(entry.file)).toString('utf8');
  const legacy = view.modern ? JSON.parse(originalText) : view.catalog;
  if (view.modern) {
    const options = new Map(view.catalog.menu.options.map((row) => [row.symbol, row]));
    const choices = new Map(view.catalog.menu.choices.map((row) => [row.id, row]));
    for (const row of legacy.menu?.options || []) {
      const next = options.get(row.symbol);
      if (next) Object.assign(row, { usageEn: next.usageEn, promptI18n: next.promptI18n, usageI18n: next.usageI18n });
    }
    for (const [name, row] of Object.entries(legacy.menu?.labels || {})) {
      const next = view.catalog.menu.labels[name];
      if (next) Object.assign(row, { i18n: next.i18n, usageI18n: next.usageI18n });
    }
    for (const row of legacy.menu?.choices || []) {
      const next = choices.get(row.id);
      if (next) Object.assign(row, { promptI18n: next.promptI18n, usageI18n: next.usageI18n });
    }
  }
  if (JSON.stringify(legacy) === originalText) return false;
  legacy.translation = { ...(legacy.translation || {}), languages: ['en', ...translationLanguages],
    fallback: 'en', updatedAt: generatedAt };
  writeFileSync(entry.file, gzipSync(Buffer.from(JSON.stringify(legacy)), { level: 9 }));
  return true;
}

export function menuLanguagePayload(catalog, language, generatedAt) {
  const options = catalog.menu?.options || [];
  const labels = catalog.menu?.labels || {};
  const choices = catalog.menu?.choices || [];
  const localized = (row, chineseKey, i18nKey) => language === 'zh-CN'
    ? String(row?.[chineseKey] || row?.[i18nKey]?.['zh-CN'] || '')
    : String(row?.[i18nKey]?.[language] || '');
  return {
    schema: 1,
    kind: 'menu-language',
    language,
    generatedAt,
    source: catalog.source,
    options: options.map((option) => {
      const title = localized(option, 'promptZh', 'promptI18n');
      const usage = localized(option, 'usageZh', 'usageI18n');
      return title || usage ? [option.symbol, title, usage] : null;
    }).filter(Boolean),
    labels: Object.entries(labels).map(([name, row]) => {
      const title = localized(row, 'zhCN', 'i18n');
      const usage = localized(row, 'usageZh', 'usageI18n');
      return title || usage ? [name, title, usage] : null;
    }).filter(Boolean),
    choices: choices.map((choice) => {
      const title = localized(choice, 'promptZh', 'promptI18n');
      const usage = localized(choice, 'usageZh', 'usageI18n');
      return title || usage ? [choice.id, title, usage] : null;
    }).filter(Boolean),
  };
}

export function writeIndexedLanguageAssets(entry, catalog, generatedAt) {
  let written = 0;
  for (const [language, file] of Object.entries(entry.languageAssets)) {
    if (!translationLanguages.includes(language)) continue;
    const payload = menuLanguagePayload(catalog, language, generatedAt);
    if (existsSync(file)) {
      const current = JSON.parse(gunzipSync(readFileSync(file)));
      const currentBody = { ...current, generatedAt: '' };
      const nextBody = { ...payload, generatedAt: '' };
      if (JSON.stringify(currentBody) === JSON.stringify(nextBody)) continue;
    }
    writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
    written += 1;
  }
  return written;
}

export function readTranslationIndex(directory) {
  const file = join(directory, 'index.json');
  if (!existsSync(file)) throw new Error('translation requires a Catalog data index.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}
