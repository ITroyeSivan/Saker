// 把 shared/ui-kit/ui-kit.css 注入到各产品插件的 SAKER-UI-KIT 标记块。
//
// 为什么用注入而不是运行时共享：插件是独立的 window.__ModuleLoader__ 工厂（不是 ESM），
// 运行时共享组件模块需要新建一个共享包；当前用「单一 CSS 来源 + 逐插件注入同一份字节」
// 保证一致，并由 test-ui-kit.mjs 核对注入结果与来源一致。
//
// 用法：node scripts/sync-ui-kit.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
const source = fs.readFileSync(path.join(root, 'shared', 'ui-kit', 'ui-kit.css'), 'utf8').trim();
const escaped = JSON.stringify(source);
const BLOCK = /(\/\* SAKER-UI-KIT:BEGIN \*\/\nvar SAKER_UI_KIT_CSS = )(.*?)(;\n\/\* SAKER-UI-KIT:END \*\/)/s;

let changed = 0, scanned = 0;
for (const name of productPluginDirectories(root)) {
  const file = path.join(root, 'plugins', name, 'lib', 'client.js');
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  if (!BLOCK.test(before)) continue;
  scanned++;
  const after = before.replace(BLOCK, (m, head, _value, tail) => head + escaped + tail);
  if (after === before) { console.log(`NOCHG ${name}`); continue; }
  changed++;
  if (apply) fs.writeFileSync(file, after);
  console.log(`${apply ? 'APPLY' : 'DRY  '} ${name}`);
}

// dsh-mcp-studio 的 lib 由 src 构建，不能直接改 lib；生成 src/client/ui-kit-css.ts 供 styles.ts 引用。
const generated = path.join(root, 'plugins', 'dsh-mcp-studio', 'src', 'client', 'ui-kit-css.ts');
if (fs.existsSync(path.dirname(generated))) {
  const content = `// 由 scripts/sync-ui-kit.mjs 生成，请勿手改。来源：shared/ui-kit/ui-kit.css\n`
    + `export const UI_KIT_CSS = ${JSON.stringify(source)}\n`;
  const before = fs.existsSync(generated) ? fs.readFileSync(generated, 'utf8') : '';
  if (before === content) {
    console.log('NOCHG dsh-mcp-studio/src');
  } else {
    changed++;
    if (apply) fs.writeFileSync(generated, content);
    console.log(`${apply ? 'APPLY' : 'DRY  '} dsh-mcp-studio/src`);
  }
}
console.log(`scanned=${scanned} changed=${changed} apply=${apply}`);
