// 执行内容闸：把根任务的测试内容选择接到结构化执行上。
//
// 迁移后：不再绑定方法分类。调用方给出测试内容键（test-catalog 的稳定 ID）时，
// 只核对当前任务是否启用了该内容；全不选时**任何**新的目标操作都被拒绝——包括
// 用户处理阻碍后的 baseline 复查，不再有基线例外。读取已存资料不受影响。
//
// 边界：
//   · 只读数据库 + 目录，不做网络 I/O，可在准入/预留事务里调用。
//   · 子任务沿用主任务的有效选择（taskModuleSelection 已做归属解析）。
//   · 闸只读取/初始化选择，不删除历史回执、不清预算。
import path from 'node:path';
import { moduleInitialization } from './content-catalog.js';
import { taskModuleSelection } from './task-modules.js';
import { TEST_CONTENT_KEYS } from './test-catalog.js';
import { chatDefaults } from './chat-setup.js';
import { readTaskPolicy, collectionModules } from './task-policy.js';

/** 库文件位于 `<home>/redteam-results/results.db`，反推 home 供目录读取。 */
export function storeHome(store) {
  return store.dbPath === ':memory:' ? (process.env.DSH_HOME || '.') : path.dirname(path.dirname(store.dbPath));
}

/** 根任务的有效内容选择 + 目录配置（子任务沿用主任务）。 */
export function rootModuleSelection(store, sessionId) {
  const policy = readTaskPolicy(store, sessionId);
  const mode = policy?.mode ?? 'regular';
  const home = storeHome(store);
  const config = moduleInitialization(home, sessionId, mode);
  // v6 5.5：新会话的测试内容初值取自“存为默认偏好”。空数组同样生效（只分析已添加内容）。
  const preferred = chatDefaults(store)?.content;
  if (Array.isArray(preferred)) config.defaults = preferred;
  return { selection: taskModuleSelection(store, sessionId, config), config, home };
}

/** 收集类工具名 → 它需要的测试内容；目录外的工具不在此处猜。 */
export function requiredContentFor(toolName) {
  return collectionModules[toolName] || [];
}

/**
 * 生成"在事务内核对最新选择"的检查函数：返回拒绝原因字符串，或 undefined 表示放行。
 * @param requiredContent 本次动作需要的测试内容稳定 ID（空数组表示只做本地处理）
 */
export function moduleGateFor(store, sessionId, requiredContent = []) {
  return () => {
    const { selection } = rootModuleSelection(store, sessionId);
    const active = new Set(selection.active);
    if (!selection.active.length) {
      return 'all_content_disabled：当前任务已关闭全部测试内容，只分析已添加内容，不再访问网站；'
        + '需要访问网站时请先重新选择测试内容（策略 modulesRev=' + selection.rev + ' policyRev=' + selection.policyRev + '）。';
    }
    const requested = [...new Set(requiredContent.filter(key => typeof key === 'string' && key))];
    const unknown = requested.filter(key => !TEST_CONTENT_KEYS.includes(key));
    if (unknown.length) return 'module_disabled：未知测试内容 ' + unknown.join('、') + '，不能作为执行许可。';
    const wanted = requested;
    const disabled = wanted.filter(key => !active.has(key));
    if (disabled.length) {
      return 'module_disabled：当前任务未启用 ' + disabled.join('、')
        + '；请先在聊天中选择该测试内容（策略 modulesRev=' + selection.rev + ' policyRev=' + selection.policyRev + '）。';
    }
    return undefined;
  };
}
