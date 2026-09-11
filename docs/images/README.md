# 截图清单

本目录两类图：

- **`00-hero-collage.png`** — README 首页的拼图封面，由 [`make-collage.py`](./make-collage.py) 从下面 15 张截图合成，**不要手工替换**。
- **`01`–`15`** — 各功能的原始截图，在 [`docs/features.md`](../features.md) 中引用。

替换截图时**保持同名覆盖**，然后重跑一次拼图脚本即可，不需要改 Markdown。

- 格式：PNG
- 建议：1600～2400px 宽，深色主题
- 截图前务必脱敏：真实 IP、域名、Token、API Key、Cookie、会话标题

## 重新生成封面

```bash
pip install pillow
python docs/images/make-collage.py
```

拼图采用**等高行**排版（每行按同一高度缩放、宽度自适应铺满），不裁剪画面内容。
封面选用的 9 张与分组如下，改选图片编辑脚本顶部的 `ROWS` 即可：

| 行 | 图片 | 分组依据 |
|---|---|---|
| 1 | `02-modes` · `03-attack-atlas` · `09-findings` | 宽幅（约 2:1） |
| 2 | `06-skills` · `07-tools1` · `08-tools2` | 中等（1.4–1.8:1） |
| 3 | `04-method-stack1` · `11-webshell1` · `13-knowledge1` | 偏方（1.1–1.9:1） |

> 同一行放宽高比接近的图，各行宽度才均衡。混着放会出现一行里一窄两宽。

## 清单

| 文件名 | 在 features.md 的小节 | 内容 |
|---|---|---|
| `00-hero-collage.png` | —（README 首屏） | 9 张功能截图拼接的封面 |
| `01-saker-overview.png` | 开篇 | 工作台总览：会话列表 + 新会话输入区 |
| `02-modes.png` | 三种模式，各有完整流程 | 新会话页展开模式选择器：渗透测试 / 代码审计 / 标准 |
| `03-attack-atlas.png` | 攻击面不再靠记忆 | AttackAtlas 矩阵：阶段带、终态图例、攻击面分类 |
| `04-method-stack1.png` | 提示词可以自己编排 | 设置 → 方法编排：会话开场自定义 + 方法勾选 |
| `05-method-stack2.png` | 提示词可以自己编排 | 会话侧栏方法组合面板：26 方法按五组勾选 |
| `06-skills.png` | 提示词、persona 和技能都可以换 | 设置 → 技能：上传安装 + 技能列表 + 引用串复制 |
| `07-tools1.png` | 工具归工具，判断归判断 | 设置 → 安全配置：工具根目录探测 + 分类导入 |
| `08-tools2.png` | 工具归工具，判断归判断 | MCP 工作台：服务列表、连接状态、工具计数 |
| `09-findings.png` | 从「可能有问题」到「可以交付」 | Redteam 成果：全局任务台账作战大屏 |
| `10-hunter.png` | 资产测绘与实测流水线 | Hunter 狩猎：DSL 查询 + 三家平台配置 |
| `11-webshell1.png` | WebShell 管理 | WebShell：上传入库、语言/绕过形式分类、改密 |
| `12-webshell2.png` | WebShell 管理 | WebShell 内置马模板库：16 种形态按语言分组 |
| `13-knowledge1.png` | 知识库随包，来源清晰可维护 | 设置 → 知识库：来源分组 + Exploit-DB 索引状态 |
| `14-knowledge2.png` | 知识库随包，来源清晰可维护 | 知识库检索测试 + 远程 Git / 本机文件夹导入 |
| `15-campaign-memory.png` | 过程留痕与跨会话记忆 | 战役记忆：分类计数、检索栏、模式切换 |

## 校验

确认 Markdown 引用的图都在（无输出即完整）：

```bash
for md in README.md docs/features.md; do
  grep -oE '\]\((\./)?(docs/)?images/[^)]+' "$md" | sed -E 's|^\]\(||; s|^\./||; s|^docs/||' | sort -u | while read f; do
    [ -f "$f" ] || echo "缺失: $f  (来自 $md)"
  done
done
```

反向检查有没有没被引用的图：

```bash
for f in docs/images/*.png; do
  grep -q "$(basename "$f")" README.md docs/features.md || echo "未引用: $f"
done
```
