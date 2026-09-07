# dsh-knowledge-hub 设计文档

> 状态：v0 设计稿（2026-09-07）。配套决策：payload 资产走「核心随包 + 导入扩展」；检索走「关键词索引定位」；本插件提供两层知识库的统一管理前端与模型检索入口。

## 1. 背景与目标

现状：saker 的知识资产（`preset/*/refs/` 手册 344 篇、semgrep 规则集）随根包以 `trust: system` 只读注册。优点是更新即整体换、卸载零残留；代价是：

1. **用户无法落笔**——个人积累、项目笔记、团队内部手册没有可写的位置；
2. **不能扩展知识源**——PayloadsAllTheThings 这类外部资产只在 refs 里留链接，模型离线拿不到全量；
3. **检索靠猜目录**——playbook 要求"grep/README 索引先导、禁止整读"，但 grep 是模型手搓的，没有结构化的定位工具。

目标（v0）：

- 新增**用户知识层** `DSH_HOME/refs/`，与包内层**层叠**（同名用户优先），前端可视化增删改查；
- 知识源**导入**能力（Git 源拉到用户层，PATT 等），离线后仍全量可用；
- 一个**关键词/正则检索工具**（`knowledge_search`），先定位到文件与行、再读原文，替代"靠 README 索引猜目录"；
- 全部走插件实现，不动宿主内核，不 fork。

明确**不做**（v0）：向量语义检索。理由：payload 是精确/按语法分类的资产，"意思相近"召回没有增益；embedding 在隔离网不可用；检索器设计成可插拔，未来要上向量只换实现不换接口。

## 2. 层叠模型

```text
加载与查找顺序（同名覆盖，用户优先）：
  ┌─ 包内层   <profile>/node_modules/dsh-saker/preset/<mode>/refs/    只读
  ├─ 用户层   DSH_HOME/refs/<mode>/<topic>/…                          可写（镜像包内主题结构）
  └─ 导入层   DSH_HOME/refs/imports/<source-name>/…                   可写（第三方全量资产，与包内主题隔离）
```

- `mode` ∈ `pentest` / `code-audit`。
- 用户层镜像包内主题目录（`web/` `api/` `zh/` …），同相对路径文件即"覆盖"；新文件新主题直接并存。
- `imports/` 单独成区，避免导入源的内部结构与包内主题错位；顶层 README 可声明来源与许可证。
- 目录不物理合并，由本插件在**读侧**做并集视图与同名优先；包内文件永不写。
- `DSH_HOME` 解析：环境变量 `DSH_HOME` 优先，缺省 `os.homedir()/.dsh`（与 trace-vault 的数据目录同源）。
- 包内层定位：host 内 `createRequire(import.meta.url).resolve('dsh-saker/package.json')` → 包根 `preset/<mode>/refs`。resolve 失败（未装根包）= 仅服务用户层，不报错降级。

## 3. 组件

```text
dsh-knowledge-hub（新插件，@dsh-external/dsh-knowledge-hub，v0.1.0）
├── lib/index.js      host：路径解析 / 层叠视图 / 检索 / RPC / 模型工具 / 上下文 manifest
├── lib/client.js     web client：设置页「知识库」tab（settings.section, order 135）
├── cordis.patch.yml  bundle 行（config 默认值见 §6）
├── README.md / LICENSE
```

### host（index.js）

依赖注入：`connection`（RPC）、`settings`（命名空间）、`systemPrompt`（manifest）、`tools`（模型工具注册）。

注册内容：

| 块 | 说明 |
|---|---|
| `settings.register('knowledge', …)` | 命名空间：`{ priority: 'user-first', topics: {} }` 等偏好，走 settings 层热载 |
| `connection.rpc.handle('/dsh-knowledge-hub', …)` | 前端 RPC，端点见 §4 |
| `defineTool` 三个模型工具 | `knowledge_search` / `knowledge_read` / `knowledge_list`，见 §5 |
| `systemPrompt.context('knowledge-hub-manifest')` | 每轮注入一行：扩展库文档数/主题/可用工具提示（有则渲染，无开销） |

### client（前端 tab）

设置页新增「知识库」分区（与「安全配置」并列），五个区块：

1. **目录树**：按 mode 分组，行级来源徽章（`包内`灰 / `用户`蓝 / `导入`紫），用户层行带操作。
2. **预览/编辑**：选中文件后显示（包内只读预览；用户/导入可编辑保存）。
3. **管理动作**：新建文档、删除（仅用户/导入层）、上传（`.md`，后续扩展 zip）。
4. **导入知识源**：Git URL + 名称 → `import_git`，状态与进度反馈（联网需求明示）。
5. **检索测试**：输入 query → 调 `search`，列出命中（路径/来源/行/预览），点命中跳转预览。

UI 沿用现有插件约定：`window.__ModuleLoader__.load`、`React.createElement`、`--dsw-alias-*` CSS 变量、`connection.rpc.call(CHANNEL, endpoint, payload)`。

## 4. RPC 契约（`/dsh-knowledge-hub`）

| endpoint | payload | 返回 | 权限 |
|---|---|---|---|
| `tree` | `{ mode }` | `{ entries: [{ path, source: 'bundle'\|'user'\|'import', size, lines }] }` | loopback |
| `read` | `{ mode, path }` | `{ content, source }`（bundle 可读不可写） | loopback |
| `write` | `{ mode, path, content }` | `{ ok }` 仅 user/import 区 | loopback + 路径白名单 |
| `create` | `{ mode, topic, filename, content }` | `{ ok, path }` | 同上 |
| `remove` | `{ mode, path }` | `{ ok }` 仅 user/import | 同上 |
| `import_git` | `{ url, name }` | `{ ok, path }`（spawn `git clone --depth 1`） | loopback + 目录白名单 |
| `search` | `{ query, mode }` | `{ hits: [{ path, source, line, preview }] }` | loopback |
| `stats` | `{}` | `{ bundleDocs, userDocs, importDocs, total }` | loopback |

统一信封沿用插件惯例：成功 `{ ok: true, value }`，失败 `{ ok: false, error }`。

**安全边界（host 强约束）**：

- 一切 fs 目标路径 = `path.resolve(base, rel)` 后必须 `startsWith(base + sep)`，否则拒绝；
- 可写区仅 `user` 与 `import` 两个基目录；`bundle` 只读；
- `import_git` 超时上限与输出大小限制，clone 目标目录必须为空且位于白名单内；
- RPC 全部 `{ authority: 'loopback' }`（宿主回环通道，不暴露公网）。

## 5. 模型工具

| 工具 | 行为 |
|---|---|
| `knowledge_search(query, mode)` | 关键词/正则扫两层（先用户层后包内），命中输出 `文件 / 来源 / 命中行号 / 预览`。大文件（>200KB）只扫标题与行索引，避免整读 |
| `knowledge_read(mode, path, offset, limit)` | 按行区间安全读取（复用 refs 的"禁整读"纪律），返回原文片段 |
| `knowledge_list(mode, topic?)` | 目录树 + 来源徽章，供模型先摸清有什么再决定读谁 |

工具描述里明确："扩展知识库/个人库/导入源（PATT 等）经此查询；包内手册仍在 preset refs 路径直接读"。`systemPrompt.context` 的 manifest 让模型知道这组工具存在与当前规模。

## 6. 配置与默认值（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-knowledge-hub
      name: '@dsh-external/dsh-knowledge-hub'
      config:
        priority: user-first        # 层叠策略：user-first | bundle-first（预留）
        topics: {}                  # 主题级启停（预留，v0 不实现 UI）
```

## 7. 迁移路径与阶段划分

- **Phase 1（本插件）**：用户层 + 导入层 + 前端 + 检索工具。落地即满足"知识库可前端维护、可扩展、可离线全量（导入后）"。
- **Phase 2（PATT 核心随包）**：从 PayloadsAllTheThings（MIT）摘高频章节（SQLi/XSS/SSRF/XXE/SSTI/File Inclusion/Upload/Command Injection/反序列化…）做成索引化资产目录随包（镜像 refs 主题，如 `pentest/refs/payloads/`），文首声明来源与 MIT 许可；整仓由用户经前端「导入 PATT」拉 `imports/payloads-all-the-things`。是否执行以用户确认为准。
- **Phase 3（可选增强）**：上传 zip/目录、主题启停 UI、检索评分排序、向量检索器可插拔实现。

## 8. 验证清单

1. 演练 home 装根包 + 本插件，设置页出现「知识库」tab；
2. `tree` 列出的包内 refs 与实际 preset 目录一致（来源=bundle）；
3. 新建 `pentest/web/demo.md` → 落 `DSH_HOME/refs/pentest/web/demo.md`；同路径文件写入后 `read` 返回用户层内容（覆盖生效）；
4. `search('fastjson')` 同时命中包内 components 手册与用户新建文件；
5. `import_git` 拉一个小型仓库成功且不越出白名单；
6. 模型工具 `knowledge_search`/`knowledge_read` 在会话中可用；
7. 不装根包时插件降级不报错（仅用户层）。
