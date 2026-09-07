# dsh-knowledge-hub 设计文档

> 状态：**v1 现状对照**（2026-09-07，对应插件 0.1.5 / 根包 0.2.0）。v0 是设计稿，v1 按已落地实现修订，并标注仍待办的增强项。
> 配套决策：外部 payload 资产走「**PATT 全量文本随包** + 按需 Git/本机导入扩展」；检索走「**关键词索引定位**」；本插件提供四来源知识库的统一管理前端与模型检索入口。

## 1. 背景与目标

现状：saker 的知识资产随根包以 `trust: system` 只读注册。最初痛点：

1. **用户无法落笔**——个人积累、项目笔记、团队内部手册没有可写的位置；
2. **不能扩展知识源**——PayloadsAllTheThings 这类外部资产只在 refs 里留链接，模型离线拿不到全量；
3. **检索靠猜目录**——没有结构化的定位工具。

目标（已实现）：

- **随包 PATT**：PayloadsAllTheThings 全量文本随根包发布（快照 commit `3ac2790`，MIT），开箱离线可用，不再只是链接；
- **用户知识层** `DSH_HOME/refs/<mode>/`，与包内层**层叠**（同名用户优先），前端可视化增删改查；
- **知识源导入**：远程 Git 克隆 + **本机文件夹整体复制**两种方式落到导入区，离线后仍全量可检索；
- 一个**关键词检索工具**（`knowledge_search`）先定位到文件与行、再读原文；
- 全部走插件实现，不动宿主内核，不 fork。

明确**不做**（现阶段）：向量语义检索。理由：payload 是精确/按语法分类的资产，"意思相近"召回没有增益；embedding 在隔离网不可用；检索器可插拔，未来上向量只换实现不换接口。

## 2. 层叠模型（四来源）

```text
只读（随包）：
  ┌─ 随包 PATT   <profile>/node_modules/dsh-saker/preset/shared/refs/PayloadsAllTheThings/   只读、跨 mode（source='patt'）
  ├─ 包内层       <profile>/node_modules/dsh-saker/preset/<mode>/refs/                         只读（source='bundle'）
可写（DSH_HOME/refs/）：
  ├─ 用户层       DSH_HOME/refs/<mode>/<topic>/…                                               可写（source='user'，按 mode 分）
  └─ 导入层       DSH_HOME/refs/imports/<source-name>/…                                        可写（source='import'，跨 mode）
```

- `mode` ∈ `pentest` / `code-audit`；`patt` 与 `import` 为通用内容，不随 mode 变化。
- 用户层镜像包内主题目录，同相对路径文件即"覆盖"（同名用户优先，读侧并集视图）；包内与 PATT 永不写。
- `imports/` 单独成区，避免导入源内部结构与包内主题错位；顶层来源声明（`_PATT_SOURCE_NOTICE.md`、`README`）说明来源与许可证。
- 检索与浏览均为四来源并集，`bundle` 仅在当前 mode 下参与。
- `DSH_HOME` 解析：环境变量优先，缺省 `os.homedir()/.dsh`。
- 包内/PATT 定位：host 内 `createRequire(import.meta.url).resolve('dsh-saker/package.json')` → 包根对应子目录；resolve 失败（未装根包）= 仅服务用户/导入层，不报错降级。

## 3. 组件

```text
dsh-knowledge-hub（@dsh-external/dsh-knowledge-hub，v0.1.5）
├── lib/index.js      host：路径解析 / 四来源并集 / 检索 / RPC / 模型工具 / 上下文 manifest
├── lib/client.js     web client：设置页「知识库」tab（settings.section, order 135）
├── cordis.patch.yml  bundle 行
├── README.md / LICENSE
```

### host（index.js）

依赖注入：`connection`（RPC）、`tools`（模型工具）、`systemPrompt`（manifest）。

注册内容：

| 块 | 说明 |
|---|---|
| `connection.rpc.handle('/dsh-knowledge-hub', …, { authority: 'loopback' })` | 前端 RPC，端点见 §4 |
| `defineTool` 三个模型工具 | `knowledge_search` / `knowledge_read` / `knowledge_list`，见 §5 |
| `systemPrompt.context('knowledge-hub')` | 每轮注入：随包 PATT（含 commit）、用户层、导入源的文档规模与来源（任一 >0 即渲染） |

### client（前端 tab）

设置页「知识库」分区，左侧四来源列 + 右侧编辑区 + 底部检索/导入，分区块：

1. **四来源分类树**：随包 PATT（橙） / 随包手册（灰） / 用户积累（蓝） / 导入知识源（紫）。顶层目录 = **主题分类分组头**（粗体 + 递归文本文件计数徽章 + 可折叠）；组内文件清爽列出；分类与根散文件不堆叠。每个来源头部显示「N 分类 · N 文件」汇总。
2. **预览/编辑**：包内与 PATT 只读；用户/导入层可编辑、新建（根目录 `+`）、删除（confirm）。
3. **导入**（两种）：远程 Git（`import_git`，成功后显示 commit 快照）；本机文件夹（`import_local`，复制运行 dsh 机器上的目录，自动跳过 `.git`）。
4. **检索测试**：关键词定位（包内 + PATT + 用户 + 导入），命中按来源徽章分组平铺，点开跳预览；失败显示原因；Enter 可触发。
5. 顶部 mode 切换 `pentest` / `code-audit`（切换清空检索结果）。

UI 沿用插件约定：`window.__ModuleLoader__.load`、`React.createElement`、`--dsw-alias-*` CSS 变量、`connection.rpc.call(CHANNEL, endpoint, payload)`。输入组件必须做 `onChange → e.target.value` 归一化（与 sec-config 同契约，勿直接透传事件）。

## 4. RPC 契约（`/dsh-knowledge-hub`，loopback）

统一信封：成功 `{ ok: true, value }`，失败 `{ ok: false, error }`。

| endpoint | payload | 返回 value | 备注 |
|---|---|---|---|
| `stats` | `{}` | `{ bundleMd, bundleRules, patt, user, imports, total }` | `patt`=随包 PATT 文本数；`total` 含全部 |
| `browse` | `{ source, mode, dir }` | `{ dirs: [{ name, rel, fileCount }], files: [{ name, rel, size }] }` | `fileCount`=该目录下递归文本文件数（分类徽章用） |
| `read` | `{ source, mode, path }` | `{ content, source, size }` | 仅文本扩展名、≤1MiB |
| `write` | `{ source, mode, path, content }` | `{ path }` | 仅 user/import |
| `remove` | `{ source, mode, path }` | `{ removed }` | 仅 user/import；目录递归删除 |
| `search` | `{ query, mode }` | `{ hits: [{ source, mode, path, line, preview }] }` | 顺序 bundle→patt→user→import；截断 60；≤200KB 全扫、更大扫头 1000 行 |
| `import_git` | `{ url, name }` | `{ path, ref }` | `git clone --depth 1`；`ref`=短 commit；120s 超时 |
| `import_local` | `{ path, name }` | `{ path, files }` | 本机目录→`imports/<name>`；`fs.cpSync` 过滤 `.git`；`files`=导入文本数 |

**安全边界（host 强约束）**：

- 一切 fs 目标 = `path.resolve(base, rel)` 后必须落在 base 内，否则拒绝（防 `../` 越界）；
- 可写区仅 `user` 与 `import`；`bundle`、`patt` 只读（write/remove 拒绝）；
- `import_git`：仅 `http(s)` URL、超时/输出上限、目录已存在即拒绝；
- `import_local`：源必须是存在的目录；拒绝复制导入区自身或其子目录（防自嵌套）；跳过 `.git`；
- RPC 全部 `{ authority: 'loopback' }`，不暴露公网。

## 5. 模型工具

| 工具 | 行为 |
|---|---|
| `knowledge_search(query, mode)` | 关键词扫 bundle(当前 mode)/patt/user/import 四来源，命中输出 来源/路径/行号/预览（大文件只扫头与文件名） |
| `knowledge_read(source, mode, path, offset, limit)` | 按行区间安全读取（默认 120 行、上限 400），source 枚举含 `patt`；import/patt 忽略 mode |
| `knowledge_list(mode, area)` | `area ∈ patt/user/import/all`；列出顶层分类目录与文件 + 统计（含 PATT） |

工具描述明确分层：随包 PATT / 个人积累 / 导入源经此查询与读取；包内手册仍在 preset refs 路径由 playbook 直接读。`systemPrompt.context` manifest 每轮告知模型当前各来源规模与随包 PATT 的 commit 出处。

## 6. 配置与默认值（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-knowledge-hub
      name: '@dsh-external/dsh-knowledge-hub'
      config:
        priority: user-first        # 层叠策略：user-first | bundle-first（预留）
```

`priority` 与主题级启停（`topics`）暂未在 UI 暴露，为预留字段。

## 7. 阶段划分与状态

- **Phase 1（✅ 完成，0.1.0–0.1.3）**：用户层 + 导入层（Git）+ 前端 + 检索/读取工具 + manifest。
- **Phase 2（✅ 完成，0.1.4–0.1.5 + 根包 0.2.0，2026-09-07）**：执行时从"高频章节摘录"调整为 **PATT 全量文本随包**——`preset/shared/refs/PayloadsAllTheThings/`（213 文本文件 / 66 章节，commit `3ac2790`，MIT，附上游 LICENSE 与 `_PATT_SOURCE_NOTICE.md`），作为第 4 只读来源 `patt` 接入浏览/检索/统计/manifest。配套 UI 改为四来源 + 分类分组视图；新增本机文件夹导入 `import_local`。需要 PATT 整仓（含图片/二进制/脚本）时仍可用 Git 或本机导入扩展。
- **Phase 3（🔲 待办候选）**：zip/批量上传 UI、主题级启停、检索排序/评分、向量检索器可插拔实现、导入源打包导出迁移。

## 8. 验证清单（回归 = `scripts/drill-knowledge-hub.mjs`）

| # | 项 | 状态 |
|---|---|---|
| 1 | 设置页出现「知识库」tab，四来源分组可浏览 | ✅ drill + 人工点检 |
| 2 | browse 包内 refs 与 preset 目录一致；dir 带 fileCount | ✅ |
| 3 | 写用户层 + 覆盖/新建/删除；bundle/patt 写拒 | ✅ |
| 4 | `search('order by')` 同时命中 PATT 与用户/导入层 | ✅ |
| 5 | `import_git` 返回 commit 快照；越界/超时/重名有护栏 | ✅（commit 快照在列） |
| 6 | `import_local` 复制、跳 `.git`、防自嵌套/重名/文件源 | ✅ |
| 7 | 模型工具三件套可用，source 含 `patt`，manifest 常显随包 PATT | ✅ |
| 8 | 不装根包时插件降级不报错（仅用户/导入层） | ✅ 设计约束 |
| 9 | PATT 计数口径：stats.patt=213（目录内全部 md/txt/yaml/yml，含来源声明；LICENSE 无扩展名不计入） | ✅ |

> 运行：`node scripts/drill-knowledge-hub.mjs "<profile>/node_modules/@dsh-external/dsh-knowledge-hub/lib/index.js"`（26 项）。
