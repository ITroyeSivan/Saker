# Saker Semgrep 真实引擎验证（2026-09-19）

## 目的

此前 `dsh-semgrep-audit` 只有注入式单测，没有真实 Semgrep 引擎语义验证。本轮在隔离 venv 安装 Semgrep 1.177.0，并用故意含 SQL 拼接漏洞的 Java 仓库做真实验证。

## 发现的缺陷

### 1. zh-CN Windows 下规则按 GBK 读取

内置规则含 UTF-8 中文。Semgrep 的 Python `pathlib.read_text()` 在中文 Windows 默认使用 GBK，真实运行直接崩溃：

```text
UnicodeDecodeError: 'gbk' codec can't decode byte 0xab
```

修复：Semgrep 子进程强制：

```text
PYTHONUTF8=1
PYTHONIOENCODING=utf-8
```

并新增回归断言，验证子进程环境确实生效。

### 2. 非 PATH 安装无法接入

`scanner-tools` 会读取安全配置里的工具路径，但 `semgrep-audit` 只认 PATH。隔离 venv 即使存在也会被报告为缺装。

修复：`dsh-semgrep-audit` 现在读取 sec-config 的 `entries` / legacy `tools` 中的 `semgrep` 路径；目录配置会在 Windows 下自动解析 `semgrep.exe` 等可执行后缀。

## 真实扫描结果

测试目标：

```java
statement.execute("SELECT * FROM users WHERE id=" + userId);
```

### custom 规则

命中 1 条：

```text
saker.test.sql-concat
Vuln.java:9
```

### 内置 Java 规则层

命中 3 条：

```text
java-sqli-createstatement
java-sqli-statement-execute
java-sqli-jdbc-concat
```

扫描产物：

- `artifacts/scans/semgrep-*.json`
- `evidence-index.md`
- `scan-reconcile.md`
- `scan-reconcile.csv`

所有命中均进入“待处置”，没有直接写成已确认漏洞。

## 回归

- `dsh-semgrep-audit`：`33/33` 通过。
- 插件升到 `1.0.7`。
- 主门禁：`37` 套，`2025 ok / 0 fail / 17 skip`，`release-gate: 6/6`。
- 真实与隔离 profile 字节同步通过。

## 宿主级工具接线验证

将 Semgrep 安装到 `C:\Users\12201\.dsh\tools\semgrep`，并写入真实/隔离 sec-config 后，启动隔离宿主，让真实模型调用 `semgrep_scan`：

```text
tool: semgrep_scan
layer: builtin-java
result: 2 hits
first rule: java-sqli-statement-execute
```

这证明配置路径到真实模型工具面的接线已生效，不依赖系统 PATH。
