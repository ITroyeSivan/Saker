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
dsh plugin --profile web add "file:./plugins/dsh-knowledge-hub/dsh-external-dsh-knowledge-hub-0.3.18.tgz"
```

设置页出现「知识库」tab。

## 功能

- 源码标签页 + 独立滚动：PATT / 随包手册 / 用户积累 / 导入知识源一次只展开一层，全局检索结果直接替代目录区，避免四棵树纵向堆叠。
- 来源内筛选：每个目录区可按键筛选当前来源；目录未展开时也会用来源限定的检索索引跨目录找文件，面对 PATT 的数十个分类不再逐项滚动或先展开碰运气。
- 阅读状态保持：打开文章只隐藏目录区，不卸载；返回后保留分类展开和滚动位置。
- 精读结果带磁盘绝对路径：`knowledge_read` 返回 `root/absPath`，证据引用不需要模型再扫文件系统定位。
- 文件预览、编辑（写用户层）、新建、删除（仅用户/导入层，包内永不写）。
- 阅读体验：打开文章后占满内容区；包内文档默认 Markdown 预览，可一键切源码，不再挤在窄列里看原始文本。
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

### 混合语种检索（0.3.0）

中文提问 + 英文术语混合是最常见的用法（"Sigma 检测规则 powershell 编码命令"），
但旧实现只靠一条 BM25 排序，CJK bigram 会把中文文档顶上来、把对症的英文文档挤掉
（实测该查询只命中一篇无关中文文档，`sigma-rules/...powershell_base64_encoded_*.yml`
排在第 9）。0.3.0 做了三件确定性的事（不引入向量库、不调模型）：

1. **术语替换**：中文安全术语按固定对照表替换成英文说法（编码命令→encoded command、
   检测规则→detection rule、计划任务→scheduled task…），替换后的整句再检索一遍（命中 -1.5）。
2. **拉丁术语单独成计划**：混合查询额外跑一遍"只含拉丁术语"的 FTS 计划，
   让 powershell / cve-xxxx 这类高精度词有自己的进榜机会（命中 -1.5）。
3. **覆盖度 rerank**：按"命中查询概念数 × 3（封顶 +12）"重排同一个候选集——
   命中 powershell/encoded/base64/rule 四个概念的文档会超过只命中 rule 的元数据噪声。

评测（真实知识库，40 条人工核对用例 + 5 条负样例）：
Top-1 **95.0%** / Top-5 **100%** / MRR **0.968** / 负样例标记 4/5；
平均耗时 **~35ms**（见下）。

### 顺带修掉的性能坑（0.3.1）

加了替换检索与额外 FTS 计划后平均耗时一度从 ~230ms 涨到 ~375ms。用 CPU profile 一查，
大头根本不在检索：`ensureKnowledgeIndex()` **每次检索都会调一次 `status()`**，
而旧实现每次都 `SELECT COUNT(*)` 整表（8.4 万 chunk，实测 ~140ms）——
等于每次知识检索都在做全表计数。计数只在重建/失效时变，改成进程内缓存
（`invalidate()` 清空、`status({ counts: true })` 强制刷新）后：
平均耗时 **375ms → 34.9ms**（比加检索改动前的 230ms 还快 6.6 倍），
Top-1/Top-5/MRR/负样例指标一字未变。

知识包的 clone / pull 属于**基础设施出站**，会先过统一出站策略
（`$DSH_HOME/saker-egress/policy.json`，实现见根包 `dsh-saker/lib/egress.js`）：
`frozen` 档下 `syncPack` 直接返回 `mode: "blocked"` 并且**一次 git 都不跑**；
`allowlist` 档只放白名单里的仓库主机。本地路径仓库不算出站，不受影响。
本插件自己的 `auto / manual / frozen` 同步模式照旧生效，两者是叠加关系。

- 所有文件写操作受目录白名单约束（仅用户/导入层），相对路径越界直接拒绝。
- RPC 走宿主 loopback 通道（`{ authority: 'loopback' }`），不暴露公网。
- 包内 refs 只读，本插件不写、不删、不改随包内容。

## License

MIT © Saker contributors
