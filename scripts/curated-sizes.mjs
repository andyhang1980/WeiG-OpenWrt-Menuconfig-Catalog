function dependencyNames(value) {
  const rows = Array.isArray(value) ? value : String(value || '').split(',');
  return rows.flatMap((part) => String(part).split('|').slice(0, 1))
    .map((part) => part.trim().replace(/^\+/, '').replace(/\s*\(.+$/, '').replace(/[<>=~].*$/, ''))
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,127}$/.test(name));
}

export function parseOpkgPackages(text) {
  return String(text).split(/\r?\n\r?\n/).map((block) => {
    const fields = {};
    let key = '';
    for (const line of block.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && key) fields[key] += ` ${line.trim()}`;
      else {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) [key, fields[key]] = [match[1], match[2]];
      }
    }
    const name = fields.Package || '';
    const size = Number(fields.Size || 0);
    const installedSize = Number(fields['Installed-Size'] || 0);
    return name && Number.isSafeInteger(size) && size >= 0
      ? {
        name,
        version: fields.Version || '',
        size,
        installedSize: Number.isSafeInteger(installedSize) && installedSize >= 0 ? installedSize : 0,
        depends: dependencyNames(fields.Depends),
      }
      : null;
  }).filter(Boolean);
}

export function parseApkDump(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const rows = Array.isArray(parsed) ? parsed : parsed.packages || parsed.package || [];
  return rows.map((row) => {
    const info = row.info && typeof row.info === 'object' ? row.info : row;
    const name = String(info.name || info.package || info.pkgname || '');
    const size = Number(info.file_size ?? info['file-size'] ?? info.size ?? info.archive_size ?? 0);
    const installedSize = Number(info.installed_size ?? info['installed-size'] ?? info.installedSize ?? 0);
    return name && Number.isSafeInteger(size) && size >= 0
      ? {
        name,
        version: String(info.version || info.pkgver || ''),
        size,
        installedSize: Number.isSafeInteger(installedSize) && installedSize >= 0 ? installedSize : 0,
        depends: dependencyNames(info.depends || info.dependencies || []),
      }
      : null;
  }).filter(Boolean);
}
