import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseContent, checkPublicContent } from './lib/public-content.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const body=['✨ 新增功能','🐛 问题修复','🎨 体验优化','⚠️ 其他变更'].map(h=>'### '+h+'\n\n- 无。').join('\n\n');
assert.doesNotThrow(()=>assertReleaseContent(body));
console.log('ok valid release sections');
assert.doesNotThrow(()=>assertReleaseContent(body+'\n- 常规测试支持 Nday 衔接。'));
console.log('ok product test mode remains allowed');
assert.throws(()=>assertReleaseContent(body+'\n- 回归 12 套，120 通过。'),/development records/);
console.log('ok regression results rejected');
assert.throws(()=>assertReleaseContent(body+'\n- '+['用户反馈','原话'].join('')+': synthetic'),/development records/);
console.log('ok development conversation rejected');
assert.throws(()=>assertReleaseContent(body.replace('### ⚠️ 其他变更','')),/Missing release section/);
console.log('ok missing release section rejected');

// 交付内容里不得出现内部工具路径与开发机绝对路径：用户拿到的是插件包，不是开发工作区。
// 实测泄漏：preset 的 Nday 说明写着 `E:\工作\Web Security\Tools\…` 和
// `node _ref/tools/nuclei-nday-scan.mjs`，照抄必然找不到文件。
const fixture = mkdtempSync(join(resolve(root, '../_ref/tmp'), 'public-content-leak-'));
try {
  const readme = join(fixture, 'README.md');
  writeFileSync(readme, '# 示例\n\n批量扫描用 `node _ref/tools/nuclei-nday-scan.mjs`。\n');
  assert.throws(() => checkPublicContent(fixture), /README\.md: internal path in shipped content/);
  console.log('ok internal _ref tooling path rejected');
  writeFileSync(readme, '# 示例\n\n模板库在 `E:\\工作\\Web Security\\Tools\\nuclei\\templates`。\n');
  assert.throws(() => checkPublicContent(fixture), /README\.md: internal path in shipped content/);
  console.log('ok developer machine path rejected');
  writeFileSync(readme, '# 示例\n\n模板库放在本机安装的 nuclei-templates 目录即可。\n');
  assert.doesNotThrow(() => checkPublicContent(fixture));
  console.log('ok user-facing wording still accepted');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log('Public release guard: 8 checks passed');
