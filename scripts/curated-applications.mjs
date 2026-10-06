import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function activeCuratedGroups(groups, items) {
  const used = new Set((items || []).map((item) => item?.group).filter(Boolean));
  const seen = new Set();
  return (groups || []).filter((group) => {
    if (!used.has(group) || seen.has(group)) return false;
    seen.add(group);
    return true;
  });
}

export function buildBranchApplicationRows(options, packageSymbols, curatedCandidates) {
  const curatedByPackage = new Map(curatedCandidates.flatMap(candidate =>
    (candidate.packages || []).map(name => [name, candidate])));
  return options.filter(option => /^PACKAGE_luci-app-[A-Za-z0-9_.+@-]+$/.test(String(option.symbol || '')) &&
    packageSymbols.has(option.symbol.slice('PACKAGE_'.length)))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map(option => {
      const name = option.symbol.slice('PACKAGE_'.length);
      const curated = curatedByPackage.get(name);
      // Presentation categories do not mutate Native option.path.
      return [option.symbol, name, curated?.group || 'Other', curated?.hot === true ? 1 : 0];
    });
}

export function buildCuratedApplications(root) {
  const config = readJson(join(root, 'catalog.config.json'));
  const translations = readJson(join(root, 'translations', 'zh-CN.json'));
  const probeUi = readJson(join(root, 'translations', 'probe-ui.json'));
  const automationPolicy = readJson(join(root, '.github', 'automation-policy.json'));
  const coverage = automationPolicy?.probe?.coverage || {};
  const defaultLimit = Number(coverage.defaultLimit);
  const maxLimit = Number(coverage.maxLimit);
  if (!Number.isInteger(defaultLimit) || !Number.isInteger(maxLimit) || defaultLimit < 1 || defaultLimit > maxLimit) {
    throw new Error('automation-policy.json requires probe.coverage defaultLimit/maxLimit');
  }
  const items = (config.curatedApplications || []).map((row) => {
    const packageName = row.packages?.[0] || '';
    const translation = translations.entries?.[`PACKAGE_${packageName}`] || {};
    return {
      id: row.id,
      package: packageName,
      group: row.group,
      ...(row.hot ? { hot: true } : {}),
      titleEn: translation.titleEn || row.id,
      titleZh: translation.titleZh || '',
      usageEn: translation.usageEn || '',
      usageZh: translation.usageZh || '',
      titleI18n: translation.titleI18n || {},
      usageI18n: translation.usageI18n || {},
    };
  });
  return {
    schema: 1,
    groups: activeCuratedGroups(config.curatedGroups, items),
    probeUi: { ...probeUi, coverage: { defaultLimit, maxLimit } },
    items,
  };
}
