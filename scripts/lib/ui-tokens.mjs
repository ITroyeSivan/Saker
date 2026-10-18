// 5.7 共享组件层的单一来源：所有 UI 令牌门禁从这里取值，
// 不再各自硬编码数字。来源见 shared/ui-kit/ui-kit.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const uiKitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UI_KIT = JSON.parse(fs.readFileSync(path.join(uiKitRoot, 'shared', 'ui-kit', 'ui-kit.json'), 'utf8'));

export const COMPONENTS = Object.freeze([...UI_KIT.components]);
export const FONT_SIZES = new Set(UI_KIT.fontSizes.map(String));
export const SPACING = new Set(UI_KIT.spacing.map(String));
export const LINE_HEIGHT = String(UI_KIT.lineHeight);
export const RADIUS = Object.freeze({
  control: `${UI_KIT.radius.control}px`,
  drawer: `${UI_KIT.radius.drawer}px`,
  pill: `${UI_KIT.radius.pill}px`,
});
export const HEIGHT = Object.freeze({
  control: `${UI_KIT.height.control}px`,
  input: `${UI_KIT.height.input}px`,
  tableRow: `${UI_KIT.height.tableRow}px`,
  icon: `${UI_KIT.height.icon}px`,
});
