// 测试内容目录的只读初始化。旧版本从 dsh-method-stack 读取；拆到本插件后，
// 即使 method-stack 退出产品安装，redteam-results 仍能读取旧用户选择做一次性迁移。
//
// 这里只处理稳定 ID、旧键迁移和旧会话记录；不读取方法正文、不扫描方法目录。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TEST_CONTENT_KEYS, migrateLegacyContent } from './test-catalog.js';

const keys = TEST_CONTENT_KEYS;

function migrateSelection(active) {
  const result = migrateLegacyContent(active);
  return { active: result.mapped, unknown: result.unknown, rev: undefined };
}

/** 旧默认偏好 / 旧会话文件只读迁移；返回 null 表示没有旧记录。 */
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
