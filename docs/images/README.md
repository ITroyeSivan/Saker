# README 截图

主 README 已引用本目录 15 张截图，路径与文件名已固定。替换截图时**保持同名覆盖**即可，不需要改 README。

- 格式：PNG
- 建议：1600～2400px 宽，深色主题
- 截图前务必脱敏：真实 IP、域名、Token、API Key、Cookie、会话标题

## 清单

| 文件名 | README 位置 | 内容 |
|---|---|---|
| `01-saker-overview.png` | 首屏 | 工作台总览：会话列表 + 新会话输入区 |
| `02-modes.png` | 两种模式 | Agent 预设页，pentest / code-audit 两个模式 |
| `03-attack-atlas.png` | 攻击面不再靠记忆 | AttackAtlas 矩阵：阶段带、终态图例、攻击面分类 |
| `04-method-stack1.png` | 测试方法可以自己编排 | 设置 → 方法编排：会话开场自定义 + 方法勾选 |
| `05-method-stack2.png` | 测试方法可以自己编排 | 会话侧栏方法组合面板：26 方法按五组勾选 |
| `06-skills.png` | 提示词、persona和技能都可以换 | 设置 → 技能：上传安装 + 技能列表 + 引用串复制 |
| `07-tools1.png` | 工具归工具，判断归判断 | 设置 → 安全配置：工具根目录探测 + 分类导入 |
| `08-tools2.png` | 工具归工具，判断归判断 | MCP 工作台：服务列表、连接状态、工具计数 |
| `09-findings.png` | 从「可能有问题」到「可以交付」 | Redteam 成果：全局任务台账作战大屏 |
| `10-hunter.png` | 资产测绘与实测流水线 | Hunter 狩猎：DSL 查询 + 三家平台配置 |
| `11-webshell1.png` | WebShell管理 | WebShell：上传入库、语言/绕过形式分类、改密 |
| `12-webshell2.png` | WebShell管理 | WebShell 内置马模板库：16 种形态按语言分组 |
| `13-knowledge1.png` | 知识库随包，来源清晰可维护 | 设置 → 知识库：来源分组 + Exploit-DB 索引状态 |
| `14-knowledge2.png` | 知识库随包，来源清晰可维护 | 知识库检索测试 + 远程 Git / 本机文件夹导入 |
| `15-campaign-memory.png` | 过程留痕与跨会话记忆 | 战役记忆：分类计数、检索栏、模式切换 |

## 校验

确认 README 引用的图片都在：

```bash
grep -oP '(?<=\]\()\./docs/images/[^)]+' README.md | sed 's|^\./||' | while read f; do [ -f "$f" ] || echo "缺失: $f"; done
```

无输出即完整。反向检查（目录里有没有没被引用的图）：

```bash
for f in docs/images/*.png; do grep -q "$(basename "$f")" README.md || echo "未引用: $f"; done
```
