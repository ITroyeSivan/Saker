# dsh-knowledge-hub

Saker 的知识库中心：随包 refs、用户积累、自动同步知识包与离线混合检索。

## 解决的问题

- 随包手册（`preset/*/refs`）只读随根包分发，用户无法落笔——本插件新增可写的**用户层** `DSH_HOME/refs/`，同名文件覆盖包内（层叠，用户优先）。
- 外部完整资产只在手册里留链接——本插件提供**导入层** `DSH_HOME/refs/imports/`，内置 20 个知识包并自动做 Git 稀疏同步。第三方内容不进 Saker 包。
- 模型找知识靠"猜目录"——本插件提供 `knowledge_search` 混合检索，先命中 chunk，再用 `knowledge_read` 精读。
- 知识量上来后子串扫描会漏、会慢——本插件用 SQLite FTS5 + BM25，中文 bigram 召回，标题/路径/许可证/metadata 参与重排。
- Exploit-DB 的元数据体积大、更新频繁，不适合随包——本插件对它做**字段化索引**：约定目录 `imports/exploitdb/`，识别到 `files_exploits.csv`（16 列：id/file/description/date_published/author/type/platform/port/.../codes/tags）即建索引，兼容旧布局 `exploits.csv` 兜底。

## 安装

```powershell
dsh plugin --profile web add "file:./plugins/dsh-knowledge-hub/dsh-external-dsh-knowledge-hub-0.2.0.tgz"
```

设置页出现「知识库」tab。

## 功能

- 三层目录树：随包手册（只读预览）/ 用户积累（可写）/ 导入知识源（可写）。
- 文件预览、编辑（写用户层）、新建、删除（仅用户/导入层，包内永不写）。
- Git 导入：URL + 名称 → 克隆到 `imports/<name>`。
- 知识包：`packs/knowledge-packs.json` 定义来源、许可证、分支、稀疏路径、适用模式和优先级；支持 `DSH_HOME/refs/packs/*.json` 用户覆盖或扩展。
- 自动同步：启动后后台同步推荐包，默认 7 天刷新；`DSH_KNOWLEDGE_AUTOSYNC=0` 可关闭。
- 后台索引：首次大索引由独立 Node 进程完成，不阻塞宿主；未就绪时搜索回退到旧扫描器。
- 混合检索：FTS5 + BM25 + 中文 bigram + 路径/标题/包权重；搜索结果返回 `chunkId`，可精确读取命中附近内容。
- Exploit-DB 索引：`edb-status` 显示接入状态与条目数；`edb-sync` 从 gitlab.com 抓 `files_exploits.csv` 与 `files_shellcodes.csv`（各限 60s 超时、1KB~300MB 校验）。检索层 EDB 字段优先，命中形如 `[EDB-12345]`；`exploitdb/` 目录本身不走文本扫描，避免把巨型 CSV 和 PoC 源码当文本读。
- 模型工具：`knowledge_search` / `knowledge_read` / `knowledge_list`；`systemPrompt.context` 在用户/导入层有内容时注入一行 manifest，EDB 索引就绪时追加 `Exploit-DB 元数据索引 N 条（离线）`。

## 知识包与许可证

目录里同时记录 `distribution`：

- `bundle-safe`：可在符合许可证的前提下随包分发。
- `separate-pack`：许可证有 share-alike 或 copyleft 要求，保持独立包。
- `local-only`：CC BY-NC、无明确许可证或来源许可待核，只做用户本地同步，不随 Saker 包分发。

同步器只拉稀疏文本子集，例如 HackTricks 只拉 `src/**/*.md`，Sigma 只拉规则 YAML；大图片、靶场二进制和无关源码不进入知识库。

## 安全

- 所有文件写操作受目录白名单约束（仅用户/导入层），相对路径越界直接拒绝。
- RPC 走宿主 loopback 通道（`{ authority: 'loopback' }`），不暴露公网。
- 包内 refs 只读，本插件不写、不删、不改随包内容。

## License

MIT © Saker contributors
