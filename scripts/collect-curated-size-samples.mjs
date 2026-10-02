#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { parseApkDump, parseOpkgPackages } from './curated-sizes.mjs';
import { matchPattern } from './source-policy.mjs';
import { parseInfoRecords } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const cli = new Map();
const positional = [];
for (let index = 2; index < process.argv.length; index++) {
  const token = process.argv[index];
  if (token.startsWith('--')) {
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${token} requires a value`);
    cli.set(token.slice(2), next);
    index++;
  } else positional.push(token);
}
const output = resolve(positional[0] || join(ROOT, 'size-samples'));
const outputFile = cli.get('output-file') ? resolve(cli.get('output-file')) : '';
const selectedSource = String(cli.get('source') || '');
const selectedBranch = String(cli.get('branch') || '');
const targetInfoPath = cli.get('tree') ? join(resolve(cli.get('tree')), 'tmp', '.targetinfo') : '';
const targetArchitectures = targetInfoPath && existsSync(targetInfoPath)
  ? [...new Set([...readFileSync(targetInfoPath, 'utf8').matchAll(/^Target-Arch-Packages:\s*([A-Za-z0-9_.+-]+)\s*$/gm)].map((row) => row[1]))].sort()
  : [];
const targets = targetInfoPath && existsSync(targetInfoPath)
  ? parseInfoRecords(readFileSync(targetInfoPath, 'utf8')) : [];
const config = JSON.parse(readFileSync(resolve(cli.get('config') || join(ROOT, 'catalog.config.json')), 'utf8'));
mkdirSync(output, { recursive: true });
if (outputFile) mkdirSync(dirname(outputFile), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'weig-curated-size-'));
// Size observations are optional. Bound their cost so unavailable official
// indexes cannot consume the source lane's native Kconfig generation budget.
const deadline = Date.now() + 6 * 60 * 1000;

async function fetchBytes(url) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('official-index-observation-budget-exhausted');
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(15000, remaining)), headers: { 'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
function directoryNames(text) {
  return [...new Set([...String(text).matchAll(/href=["'](?:\.\/)?([A-Za-z0-9_.+-]+)\/["']/g)]
    .map((row) => row[1]).filter((name) => name !== '.' && name !== '..'))];
}
function observationUrls(source, version, architecture) {
  return [...new Set([source.baseUrl, ...(source.fallbackBaseUrls || [])].filter(Boolean)
    .map((url) => url.replaceAll('{architecture}', architecture).replaceAll('{version}', version)))];
}
async function discoverTargetRepositories(source, version) {
  const templates = [source.targetBaseUrl].filter(Boolean);
  const failures = [];
  for (const root of source.releaseRoots || []) {
    try {
      const releases = directoryNames((await fetchBytes(root)).toString('utf8'))
        .filter((name) => name === version || name === `${version}-SNAPSHOT` ||
          (name.startsWith(`${version}.`) && /^\d+(?:\.\d+)+$/.test(name)))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 3);
      for (const release of releases) templates.push(`${root.replace(/\/$/, '')}/${release}/targets/{board}/{subtarget}/packages`);
    } catch (error) { failures.push({ url: root, error: String(error.message || error) }); }
  }
  const repositories = new Map();
  for (const target of targets) {
    if (!templates.length) break;
    if (![target.board, target.subtarget, target.archPackages].every((value) => /^[A-Za-z0-9_.+-]+$/.test(value))) continue;
    const urls = repositories.get(target.archPackages) || new Set();
    for (const template of templates) urls.add(template.replaceAll('{board}', target.board)
      .replaceAll('{subtarget}', target.subtarget).replaceAll('{version}', version));
    repositories.set(target.archPackages, urls);
  }
  return { repositories, failures };
}

async function collectArchitecture(source, branch, version, architecture, targetRepositories = []) {
  const baseUrls = observationUrls(source, version, architecture);
  const baseUrl = baseUrls[0];
  const packages = new Map();
  const failures = [];
  const repositories = new Set();
  for (const root of baseUrls) {
    let feeds = source.feeds || [];
    try {
      // Discover extra official feeds without maintaining a browser/source
      // package list. Configured feeds remain usable when listings are absent.
      const discovered = directoryNames((await fetchBytes(root + '/')).toString('utf8'));
      if (discovered.length) feeds = [...new Set([...feeds, ...discovered])];
    } catch (error) { failures.push({ url: root, error: String(error.message || error) }); }
    for (const feed of feeds) if (/^[A-Za-z0-9_.+-]+$/.test(feed)) repositories.add(`${root.replace(/\/$/, '')}/${feed}`);
  }
  // Common architecture feeds have priority within the optional time budget.
  for (const repository of targetRepositories) repositories.add(repository);
  for (const repository of repositories) {
    const formats = source.format === 'auto' ? ['apk', 'opkg'] : [source.format];
    for (const format of formats) {
      const extension = format === 'apk' ? 'packages.adb' : 'Packages.gz';
      const url = `${repository.replace(/\/$/, '')}/${extension}`;
      try {
        const data = await fetchBytes(url);
        let rows;
        if (format === 'apk') {
          const file = join(temp, `${source.id}-${branch}-${architecture}-${repositories.size}-${packages.size}.adb`.replace(/[^A-Za-z0-9_.-]/g, '-'));
          writeFileSync(file, data);
          const { stdout: json } = await execute('docker', [
            'run', '--rm', '-v', `${temp.replace(/\\/g, '/')}:/work`, 'alpine:edge',
            'apk', 'adbdump', '--format', 'json', `/work/${file.split(/[\\/]/).pop()}`,
          ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Math.min(60000, Math.max(1, deadline - Date.now())) });
          rows = parseApkDump(json);
        } else {
          rows = parseOpkgPackages(gunzipSync(data).toString('utf8'));
        }
        for (const row of rows) {
          const key = JSON.stringify([row.name, row.version]);
          const previous = packages.get(key);
          // Preserve exact versions across repositories. Conflicting size
          // observations for one identity must not become a guessed total.
          if (previous?.sizeAmbiguous) continue;
          if (previous?.installedSize > 0 && row.installedSize > 0 && previous.installedSize !== row.installedSize) {
            packages.set(key, { ...previous, installedSize: null, sizeAmbiguous: true });
          } else if (!previous || row.installedSize > 0 || !(previous.installedSize > 0)) packages.set(key, row);
        }
        break;
      } catch (error) {
        failures.push({ repository, url, error: String(error.message || error) });
      }
    }
  }
  const sample = {
    schema: 2, generatedAt: new Date().toISOString(), source: source.id, branch,
    architecture, format: source.format, baseUrl, available: packages.size > 0,
    repositories: [...repositories],
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), failures,
  };
  if (!packages.size) {
    console.warn(`${source.id}/${branch}/${architecture}: no official observation`);
    return { ...sample, reason: 'official-package-index-unavailable' };
  }
  const destination = join(output, `${source.id}--${branch}--${architecture}.json`.replace(/[^A-Za-z0-9_.-]/g, '-'));
  writeFileSync(destination, JSON.stringify(sample) + '\n');
  console.log(`${source.id}/${branch}/${architecture}: packages=${packages.size} failed-feeds=${failures.length}`);
  return { architecture, available: true, file: relative(dirname(outputFile || destination), destination).replaceAll('\\', '/') };
}

try {
  const configured = (config.curatedSizeSources || []).filter((source) =>
    (!selectedSource || source.id === selectedSource) && (!selectedBranch || matchPattern(selectedBranch, source.branch)));
  const observations = [];
  if (selectedSource && selectedBranch && configured.length === 0 && outputFile) {
    writeFileSync(outputFile, JSON.stringify({
      schema: 2,
      generatedAt: new Date().toISOString(),
      source: selectedSource,
      branch: selectedBranch,
      available: false,
      reason: 'no-exact-official-index-source',
      packages: [],
      failures: [],
    }) + '\n');
    console.log(`${selectedSource}/${selectedBranch}: no exact official package-index source`);
  }
  for (const source of configured) {
    const branch = selectedBranch || source.branch;
    const version = source.branchPrefix && branch.startsWith(source.branchPrefix)
      ? branch.slice(source.branchPrefix.length) : branch;
    const architectures = targetArchitectures.length ? targetArchitectures : [source.architecture].filter(Boolean);
    if (!architectures.length) continue;
    const targetRepositories = await discoverTargetRepositories(source, version);
    observations.push(...targetRepositories.failures.map((failure) => ({ available: false,
      source: source.id, branch, reason: 'official-release-listing-unavailable', failures: [failure] })));
    let availableArchitectures = architectures;
    if (source.baseUrl.includes('{architecture}')) {
      const published = new Set(targetRepositories.repositories.keys());
      for (const template of [source.baseUrl, ...(source.fallbackBaseUrls || [])]) {
        const rootUrl = template.replace(/\{architecture\}.*$/, '').replaceAll('{version}', version);
        try {
          for (const name of directoryNames((await fetchBytes(rootUrl)).toString('utf8'))) published.add(name);
        } catch (error) {
          observations.push({ available: false, source: source.id, branch, reason: 'official-index-root-unavailable',
            failures: [{ url: rootUrl, error: String(error.message || error) }] });
        }
      }
      availableArchitectures = architectures.filter((architecture) => published.has(architecture));
    }
    const collected = new Array(availableArchitectures.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, availableArchitectures.length) }, async () => {
      while (next < availableArchitectures.length) {
        const index = next++;
        const architecture = availableArchitectures[index];
        collected[index] = await collectArchitecture(source, branch, version, architecture,
          targetRepositories.repositories.get(architecture) || []);
      }
    }));
    observations.push(...collected);
  }
  if (outputFile && configured.length) writeFileSync(outputFile, JSON.stringify({
    schema: 3, generatedAt: new Date().toISOString(), source: selectedSource, branch: selectedBranch,
    available: observations.some((row) => row.available), observations,
    reason: observations.length ? 'official-observations' : 'native-target-architectures-unavailable',
  }) + '\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
