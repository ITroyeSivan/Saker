# Saker v0.3.5

## 修复

- 报告草稿生成器现在把 `impact` 证据等级输出为中文“影响已证”，与成果页词表一致，不再在正式交付文档里留下英文枚举值。
- 报告草稿回归新增断言：`impact -> 影响已证`，并继续锁住“证据不足的草稿不能过 P2 门禁”。
- `dsh-semgrep-audit 1.0.7` 在子进程强制 UTF-8，修复 zh-CN Windows 上 Semgrep 按 GBK 读取中文规则导致的 `UnicodeDecodeError`。
- `dsh-semgrep-audit` 现在读取 sec-config 中的 `semgrep` 工具路径，非 PATH 安装也可直接使用。
- `dsh-scanner-tools 1.0.13` 将 ffuf 的 `-o` JSON 命中回传到模型回执，直接显示状态码、大小和 URL，不再要求模型额外读产物猜结果。
- `dsh-scanner-tools 1.0.14` 修正 katana 参数：目标必须走官方 `-u <url>`，避免“exit 0 但输出为空”的静默失效。
- `dsh-webshell-mgr 1.1.27` 修复 Windows 基础命令马的三处兼容问题：cmd.exe 8191 字符分块上限、certutil 中文状态行污染 base64、中文 Windows 24 小时 `dir` 解析。
- `dsh-webshell-mgr 1.1.28` 修复模型工具参数映射：`pass_param` / `cmd_param` / `secret_key` 现在正确映射到连接核心，不再静默回退到 `pass` / `cmd`。

## 验证

- 浏览器实际导出真实 finding 的 HTML 与 JSON 报告。
- JSON 通过 `saker.redteam.report.v1` 校验，warning 为 0。
- 六字段 MD 草稿可生成，重复运行不覆盖旧稿。

## 关联

- `dsh-knowledge-hub` 同步升级到 `0.3.6`，增加 Markdown 阅读预览与响应式正文布局。
- Semgrep 真实引擎验证：custom 规则命中 1 条，内置 Java 规则层命中 3 条，产物与对账文件全部落盘。
