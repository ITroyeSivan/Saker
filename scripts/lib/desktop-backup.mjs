// 更新前备份（v6 第 13 节）：更新前备份真实配置、会话/MCP、相关数据与**匹配构建**（安装清单与锁定文件）。
//
// 为什么单独成模块：安装流程本身只跑官方事务，备份必须能在**不装任何东西**的前提下单独验证。
// 默认只复制小体积的关键配置（package.json / lockfile / cordis*.yml，其中 cordis.patch.yml 就是 MCP 与日常配置），
// 并对会话与产品数据目录做**清单**（存在性与字节数）；要整体复制数据时显式传 includeData。
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const BACKUP_SCHEMA = 'saker.desktop-backup/2';
/** 档案里体积小、且决定"下次启动长什么样"的文件。cordis.patch.yml 含 MCP 与日常配置。 */
export const CONFIG_FILES = Object.freeze(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']);
/** 默认要盘点/可复制备份的数据目录（相对 DSH_HOME）。 */
const COMMON_DATA_PATHS = ['sessions', 'attachments', 'redteam-results', 'storages', 'nday-hunter', 'hunter', 'refs',
  'product-subagents', 'saker-egress', 'saker-metrics', '.credentials.yaml', '.anonymous-user-id'];
export const DATA_PATHS = Object.freeze([...COMMON_DATA_PATHS, 'profiles/desktop/node_modules/.modules.yaml']);
export const dataPathsFor = (profileName = 'desktop') => Object.freeze([...COMMON_DATA_PATHS,
  `profiles/${profileName}/node_modules/.modules.yaml`]);

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function contained(root, rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel)) throw new Error('备份路径必须是相对路径');
  const absolute = resolve(root, rel), base = resolve(root);
  if (!absolute.startsWith(base + sep)) throw new Error('备份路径越界：' + rel);
  return absolute;
}
function inventory(target, prefix = '') {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('备份遇到链接，未复制或覆盖：' + target);
  if (stat.isDirectory()) return [{ path: prefix, type: 'directory' }, ...readdirSync(target).sort()
    .flatMap(name => inventory(join(target, name), prefix ? prefix + '/' + name : name))];
  if (!stat.isFile()) throw new Error('备份不支持这种文件类型：' + target);
  return [{ path: prefix, type: 'file', bytes: stat.size, sha256: sha256(target) }];
}
function sizeOf(target) {
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(target)) {
    try { total += sizeOf(join(target, name)); } catch { /* 并发消失的文件不计入 */ }
  }
  return total;
}

/**
 * 备份桌面档案。返回 { directory, record }；不改动任何被备份的文件。
 * @param {{home: string, now?: number, includeData?: boolean, dataPaths?: string[]}} options
 */
export function backupDesktopProfile({ home, now = Date.now(), includeData = false, dataPaths = DATA_PATHS, profileName = 'desktop', backupRoot = join(home, 'backups') }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) throw new Error('无效的 Desktop 档案名');
  const profile = join(home, 'profiles', profileName);
  if (!existsSync(profile)) throw new Error('Desktop 档案尚未初始化（先打开一次 Desktop，再更新）');
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const directory = join(backupRoot, `desktop-${stamp}`);
  mkdirSync(join(directory, 'profile'), { recursive: true });

  const files = [];
  for (const name of CONFIG_FILES) {
    const source = join(profile, name);
    if (!existsSync(source)) continue;
    const target = join(directory, 'profile', name);
    cpSync(source, target);
    files.push({ name, bytes: statSync(target).size, sha256: sha256(target) });
  }
  // 匹配构建：记下更新前的依赖版本与已启用插件，回退时才知道该装回哪一套。
  const manifestPath = join(profile, 'package.json');
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

  const data = [];
  for (const rel of dataPaths) {
    const source = contained(home, rel);
    if (!existsSync(source)) { data.push({ path: rel, present: false, bytes: 0, copied: false }); continue; }
    const entry = { path: rel, present: true, bytes: sizeOf(source), copied: false };
    if (includeData) {
      const before = inventory(source);
      const target = contained(join(directory, 'data'), rel);
      mkdirSync(join(directory, 'data', rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      cpSync(source, target, { recursive: true });
      entry.inventory = inventory(target);
      if (JSON.stringify(before) !== JSON.stringify(entry.inventory) || JSON.stringify(before) !== JSON.stringify(inventory(source)))
        throw new Error('数据在备份过程中改变，未生成可恢复档案：' + rel);
      entry.copied = true;
    }
    data.push(entry);
  }

  const record = { schema: BACKUP_SCHEMA, createdAt: new Date(now).toISOString(), home, profile, profileName,
    includeData, previousDependencies: previous.dependencies ?? {}, previousBundles: previous.dsh?.profile?.bundles ?? [],
    files, data, note: includeData ? '配置与数据均已复制；秘密仍以原文件为准，恢复后请重新确认。'
      : '只复制了小体积关键配置；数据目录仅登记存在性与字节数，需要整体复制时加 --backup-data。' };
  writeFileSync(join(directory, 'backup.json'), JSON.stringify(record, null, 2) + '\n');
  return { directory, record };
}

// ── 回退（v6 第 13 节）：程序与数据格式分别核对，必要时用对应备份恢复 ──────────────
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

/** Only known application files have a format contract. Uploaded files are opaque. */
function checkDataFile(file, label, problems) {
  if (label === 'redteam-results/results.db') {
    const head = readFileSync(file).subarray(0, 16);
    if (!head.equals(SQLITE_HEADER)) problems.push(`${label} 不是 SQLite 文件（头部不匹配）`);
  }
}

// 数据清单里既有目录（sessions、redteam-results），也有单个文件
// （profiles/desktop/node_modules/.modules.yaml）——真机备份正是后者把旧实现打成了 ENOTDIR。
function checkDataFormat(target, label, problems) {
  if (!statSync(target).isDirectory()) { checkDataFile(target, label, problems); return; }
  if (label === 'redteam-results' && existsSync(join(target, 'results.db')))
    checkDataFile(join(target, 'results.db'), 'redteam-results/results.db', problems);
}

/**
 * 备份档案自检：配置副本逐字节对得上记录、数据副本认得出格式、格式版本认识。
 * 不改动任何文件；回退前必须先跑它，避免把坏档案盖回正在用的配置。
 */
export function inspectDesktopBackup(directory) {
  const recordPath = join(directory, 'backup.json');
  if (!existsSync(recordPath)) throw new Error('备份档案缺少 backup.json：' + directory);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (![BACKUP_SCHEMA, 'saker.desktop-backup/1'].includes(record.schema)) throw new Error('不认识的备份格式：' + (record.schema ?? '(空)'));
  const problems = [];
  const files = [];
  for (const file of record.files ?? []) {
    if (!CONFIG_FILES.includes(file.name)) throw new Error('不认识的配置路径：' + file.name);
    const copy = contained(join(directory, 'profile'), file.name);
    if (!existsSync(copy)) { problems.push(`配置副本缺失：${file.name}`); continue; }
    const digest = sha256(copy);
    if (digest !== file.sha256) problems.push(`配置副本与记录不一致：${file.name}`);
    files.push({ name: file.name, bytes: statSync(copy).size, sha256: digest });
  }
  const data = [];
  for (const entry of record.data ?? []) {
    const copy = contained(join(directory, 'data'), entry.path);
    const copied = entry.copied === true && existsSync(copy);
    if (entry.copied === true && !copied) problems.push(`数据副本缺失：${entry.path}`);
    if (copied) {
      const actual = inventory(copy);
      if (!Array.isArray(entry.inventory)) problems.push(`数据副本缺少逐文件摘要，不能自动恢复：${entry.path}`);
      else if (JSON.stringify(actual) !== JSON.stringify(entry.inventory)) problems.push(`数据副本与记录不一致：${entry.path}`);
      checkDataFormat(copy, entry.path, problems);
    }
    data.push({ path: entry.path, copied });
  }
  return { record, directory, files, data, problems };
}

/**
 * 按档案回退。默认只出方案（不写任何文件）；apply=true 才写，且写之前先把当前配置
 * 存成 `backups/desktop-pre-restore-<时间>`，所以回退本身也可再回退。
 * 返回里带 `rebuild`：更新前的依赖与已启用插件，用来装回匹配构建。
 */
export function restoreDesktopProfile({ home, directory, apply = false, now = Date.now() }) {
  const inspection = inspectDesktopBackup(directory);
  if (inspection.problems.length) throw new Error('备份档案自检未通过：\n' + inspection.problems.join('\n'));
  const profileName = inspection.record.profileName ?? 'desktop';
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) throw new Error('无效的 Desktop 档案名');
  const profile = join(home, 'profiles', profileName);
  if (!existsSync(profile)) throw new Error('Desktop 档案尚未初始化（先打开一次 Desktop，再回退）');
  const rebuild = { dependencies: inspection.record.previousDependencies ?? {}, bundles: inspection.record.previousBundles ?? [] };
  const plan = {
    profile,
    config: inspection.files.map(file => file.name),
    data: inspection.data.filter(entry => entry.copied).map(entry => entry.path),
    removeData: inspection.record.includeData ? (inspection.record.data ?? []).filter(entry => entry.present === false).map(entry => entry.path) : [],
    rebuild,
  };
  if (!apply) return { applied: false, plan };
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const safety = join(home, 'backups', `desktop-pre-restore-${stamp}`);
  const affected = [...plan.data, ...plan.removeData];
  for (const rel of affected) {
    const target = contained(home, rel);
    if (existsSync(target)) inventory(target);
  }
  // Refuse overlapping roots before moving anything: a second move must never
  // operate on a directory already archived by the first one.
  for (let i = 0; i < affected.length; i++) for (let j = i + 1; j < affected.length; j++) {
    const a = contained(home, affected[i]), b = contained(home, affected[j]);
    if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep)) throw new Error('恢复路径重叠，未写入任何数据');
  }
  mkdirSync(dirname(safety), { recursive: true });
  mkdirSync(safety); // Never reuse an existing recovery archive.
  const safetyFiles = [], safetyData = [];
  const currentManifest = existsSync(join(profile, 'package.json')) ? JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) : {};
  for (const name of CONFIG_FILES) {
    const current = join(profile, name);
    if (!existsSync(current)) continue;
    inventory(current);
    mkdirSync(join(safety, 'profile'), { recursive: true });
    safetyFiles.push({ name, bytes: statSync(current).size, sha256: sha256(current) });
    renameSync(current, join(safety, 'profile', name));
  }
  for (const rel of affected) {
    const current = contained(home, rel);
    if (!existsSync(current)) { safetyData.push({ path: rel, present: false, bytes: 0, copied: false }); continue; }
    const files = inventory(current), destination = contained(join(safety, 'data'), rel);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(current, destination);
    safetyData.push({ path: rel, present: true, copied: true, bytes: files.reduce((n, file) => n + (file.bytes || 0), 0), inventory: files });
  }
  writeFileSync(join(safety, 'backup.json'), JSON.stringify({ schema: BACKUP_SCHEMA, createdAt: new Date(now).toISOString(), home, profile, profileName,
    includeData: inspection.record.includeData, previousDependencies: currentManifest.dependencies ?? {}, previousBundles: currentManifest.dsh?.profile?.bundles ?? [],
    files: safetyFiles, data: safetyData }, null, 2) + '\n');
  writeFileSync(join(safety, 'restore.json'), JSON.stringify({ schema: BACKUP_SCHEMA, restoredFrom: directory, at: new Date(now).toISOString(), plan }, null, 2) + '\n');
  for (const file of inspection.files) cpSync(join(directory, 'profile', file.name), join(profile, file.name));
  for (const entry of inspection.data.filter(item => item.copied)) {
    const source = join(directory, 'data', entry.path);
    const target = contained(home, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  return { applied: true, plan, safety };
}
