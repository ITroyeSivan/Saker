// Read-only initialization shared with the task owner. Never loads method bodies.
//
// 迁移后：测试内容目录由本文件声明 17 项稳定 ID（界面显示中文用途，后台只按 ID
// 判断动作），只读旧记录做一次性迁移，不再扫描方法目录、不再按方法分类键判断动作。
// redteam-results 的 test-catalog 再导出这份目录，避免两处清单漂移。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TEST_CONTENT_KEYS, migrateLegacyContent } from '@dsh-external/dsh-redteam-results/test-catalog';
const builtin = fileURLToPath(new URL('./methods/', import.meta.url));
const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const keys = TEST_CONTENT_KEYS;

/** 旧会话文件 / 旧默认偏好里的键迁移为稳定 ID。返回 null 表示没有旧记录。 */
function migrateSelection(active) {
  const result = migrateLegacyContent(active);
  return { active: result.mapped, unknown: result.unknown, rev: undefined };
}

export function moduleInitialization(home, sessionId, mode) {
  let preferred;
  try { preferred = JSON.parse(fs.readFileSync(path.join(home, 'method-stack/profiles/pentest.json'), 'utf8')).webDefaults; }
  catch (error) { if (error.code !== 'ENOENT') throw Error('默认测试内容读取失败：' + error.message); }
  const defaults = preferred === undefined ? keys : migrateSelection(preferred).active;
  return { keys, defaults, legacy: () => readLegacyModules(home, sessionId, mode) };
}
export function readLegacyModules(home, sessionId, mode) {
  const file = path.join(home, 'method-stack/sessions', createHash('sha256').update(sessionId).digest('hex') + '.' + mode + '.json');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('旧测试内容设置读取失败：' + error.message); return null; }
  const migrated = migrateSelection(record?.active);
  return { active: migrated.active, unknown: migrated.unknown, rev: record?.rev ?? 1 };
}

/**
 * 内置 + 用户层 Web 方法的**完整条目**（含正文），键为 `group/id`。
 * 与 moduleInitialization 同一套目录规则（用户层同名覆盖官方），供方法分类与执行闸
 * 计算确定指纹用。只读离线文件，不执行任何请求；调用点在执行路径，不在每轮注入路径。
 */
export function methodCatalogEntries(home) {
  const out = {};
  for (const group of ['recon', 'exploit']) {
    for (const root of [builtin, path.join(home, 'method-stack/methods')]) {
      let entries;
      try { entries = fs.readdirSync(path.join(root, group), { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
        const dir = path.join(root, group, entry.name);
        try {
          const manifest = fs.readFileSync(path.join(dir, 'manifest.yml'), 'utf8');
          if (!/^name:\s*[A-Za-z0-9][A-Za-z0-9._-]{0,63}\s*$/m.test(manifest)) continue;
          const prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
          if (!prompt.trim()) continue;
          out[group + '/' + entry.name] = { group, id: entry.name, prompt, manifest };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  return out;
}
