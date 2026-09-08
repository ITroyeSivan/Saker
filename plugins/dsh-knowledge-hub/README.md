# dsh-knowledge-hub

Saker 的知识库中心：两层 refs（随包只读 + 用户可写）与外部知识源导入。

## 解决的问题

- 随包手册（`preset/*/refs`）只读随根包分发，用户无法落笔——本插件新增可写的**用户层** `DSH_HOME/refs/`，同名文件覆盖包内（层叠，用户优先）。
- 外部完整资产（PayloadsAllTheThings 等）只在手册里留链接——本插件提供**导入层** `DSH_HOME/refs/imports/`，前端一键 `git clone`，之后完全离线可用。
- 模型找知识靠"猜目录"——本插件提供 `knowledge_search` 定位工具（先命中文件/行，再 `knowledge_read` 读原文）。
- Exploit-DB 的元数据体积大、更新频繁，不适合随包——本插件对它做**字段化索引**：约定目录 `imports/exploitdb/`，识别到 `files_exploits.csv`（16 列：id/file/description/date_published/author/type/platform/port/.../codes/tags）即建索引，兼容旧布局 `exploits.csv` 兜底。

## 安装

```powershell
dsh plugin --profile web add "file:./plugins/dsh-knowledge-hub/dsh-external-dsh-knowledge-hub-0.1.10.tgz"
```

设置页出现「知识库」tab。设计细节见仓库 `docs/knowledge-hub-design.md`。

## 功能

- 三层目录树：随包手册（只读预览）/ 用户积累（可写）/ 导入知识源（可写）。
- 文件预览、编辑（写用户层）、新建、删除（仅用户/导入层，包内永不写）。
- Git 导入：URL + 名称 → 克隆到 `imports/<name>`。
- 检索测试：关键词定位覆盖三层（≤200KB 文件全扫，更大文件扫头部 + 文件名）。
- Exploit-DB 索引：`edb-status` 显示接入状态与条目数；`edb-sync` 从 gitlab.com 抓 `files_exploits.csv` 与 `files_shellcodes.csv`（各限 60s 超时、1KB~300MB 校验）。检索层 EDB 字段优先，命中形如 `[EDB-12345]`；`exploitdb/` 目录本身不走文本扫描，避免把巨型 CSV 和 PoC 源码当文本读。
- 模型工具：`knowledge_search` / `knowledge_read` / `knowledge_list`；`systemPrompt.context` 在用户/导入层有内容时注入一行 manifest，EDB 索引就绪时追加 `Exploit-DB 元数据索引 N 条（离线）`。

## 安全

- 所有文件写操作受目录白名单约束（仅用户/导入层），相对路径越界直接拒绝。
- RPC 走宿主 loopback 通道（`{ authority: 'loopback' }`），不暴露公网。
- 包内 refs 只读，本插件不写、不删、不改随包内容。

## License

MIT © Saker contributors
