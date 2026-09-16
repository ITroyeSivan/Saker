# Saker v0.3.0

## 知识库

- `dsh-knowledge-hub` 升级到 `0.2.0`。
- 新增 20 个自动同步知识包，覆盖 CTF、Web、API、内网/AD、云、Windows/Linux 提权、移动、硬件、DFIR、应急响应与检测规则。
- 第三方内容只进 `DSH_HOME/refs/imports/`，使用 Git 稀疏同步；无许可证、CC BY-NC、GPL 内容不混入 MIT 根包。
- 新增离线混合检索：SQLite FTS5、BM25、中文 bigram、标题/路径/知识包权重、chunkId 精读与上下文预算上限。
- 首次全量索引由独立进程后台构建，不阻塞宿主启动；未就绪时回退到扫描器。
- 设置页新增知识包状态、同步全部、重建索引和失败原因展示。

## 兼容

- 现有 `knowledge_search` / `knowledge_read` / `knowledge_list` 参数保持兼容；新增 `limit`、`hitId` 和 `area=index|packs`。
- `DSH_HOME/refs/imports/` 与 `refs/exploitdb/` 数据结构不变。
- 根模式包版本升级为 `0.3.0`。

## 验证

- knowledge-hub 单元测试覆盖分层检索、路径越界、写入、EDB、中文/英文 FTS、增量删除与上下文上限。
- 真实知识包同步、稀疏 checkout、后台索引与跨方向查询在真实 `DSH_HOME` 验证。
