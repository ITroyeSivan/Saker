# Saker WebShell 管理器真实 PHP 回路（2026-09-19）

## 环境

本机原本没有 PHP。为了验证真实 WebShell 协议，本次在隔离目录安装 PHP 8.3.31：

```text
_ref/php-dist/php/php.exe
```

启用扩展：`openssl`、`pdo_sqlite`、`sqlite3`、`mbstring`、`fileinfo`、`curl`。未修改系统 PATH。

## 发现的 Windows 兼容问题

### 1. cmd.exe 8191 字符上限

基础命令马通过 cmd.exe 调用 PowerShell 写文件。原先每块 24000B，base64 后约 32KB，必然超过 cmd.exe 的 8191 字符命令行上限。

修复：

```text
Windows 命令通道 chunk = 4000B
eval/POST 通道保持 24000B
```

### 2. certutil 中文状态行污染 base64

`cleanB64Output` 逐行剥离状态文字后，中文 certutil 状态里的数字被保留，形成：

```text
=20=86QUFB...
```

读取结果变成 0 字节。

修复：优先截取 `BEGIN/END CERTIFICATE` 块，不再从状态行里刮 base64。

### 3. zh-CN Windows 24 小时 dir 格式

中文 Windows 的 `dir` 输出形如：

```text
2026/09/19  05:42    <DIR>          .
2026/09/19  05:42             4,000 chunk.bin
```

原解析器只支持 `MM/DD/YYYY + AM/PM`，且不支持 `YYYY/MM/DD`。

修复：同时支持两种日期顺序，AM/PM 改为可选。

### 4. 测试清理误报

PHP/SQLite 在 Windows 上退出后短暂保留文件句柄，`rmSync` 的 EPERM 曾把全绿功能测试判为失败。测试改为等待子进程收尾并有限重试，清理失败不影响功能结论。

## 真实回路结果

启用隔离 PHP 后运行：

```text
dsh-webshell-mgr: 54 ok / 0 fail / 2 skip
```

通过项包括：

- 一句话 eval 马：识别、命令执行、结构化 ls、二进制读写。
- 基础命令马：口令门、命令翻译、30KB 分块写读、中文 Windows dir 解析。
- 自研 AES v2：识别、加密通道命令、原生读写、eval ls。
- 冰蝎型 PHP 马：识别、桥接 eval、结构化 ls。
- 哥斯拉型 PHP 马：识别、桥接 eval、SQLite PDO 查询。
- PHP SQLite PDO 全链路。
- sysinfo / portscan 载荷插件。

2 个 skip 仅因仓库包内不存在外部 av-lab 的两匹魔改马文件，不是协议失败。

## 模型级真实回路

在隔离宿主中运行真实模型，提示只说明本地授权的 PHP WebShell 与连接参数，没有替模型选择工具。模型自行调用：

```text
tool_pack(webshell)
webshell_connect(pass_param="x", ...)
webshell_exec(command="echo WEBSHELL_MODEL_OK")
webshell_list()
```

关键回显：

```text
已连接 127.0.0.1（cmd-eval/php，OS=windows，id=ws_1362d88762fc）
WEBSHELL_MODEL_OK
ws_1362d88762fc 127.0.0.1 [cmd-eval/php] os=windows ok
```

会话 `session-6bffcb67-190d-493f-9f8c-f0eaa511ad7b` 的 transcript 同时记录了上述 `tool/call` 与 `tool/result`，证明不是只读代码或单测。

## 参数静默失效根因

模型工具 schema 暴露的是 `pass_param`、`cmd_param`、`secret_key`，但 `connectCore()` 最初只读取 camelCase 的 `passParam`、`cmdParam`、`secretKey`。模型按 schema 传 `pass_param=x` 时实际被忽略，连接退回到默认参数名 `pass`，导致协议探测全部失败，而工具返回值没有任何“参数被忽略”的信号。

修复：导出 `connectSpec()`，同时接受 snake_case 与 camelCase。回归测试固定覆盖：

```text
connectSpec({ pass_param, cmd_param, secret_key })
  -> { passParam, cmdParam, secretKey }
```

## 回归

- 插件升到 `1.1.28`。
- 主门禁带 PHP PATH 重跑：
  - `37` 套
  - `2037 ok / 0 fail / 18 skip`
  - `release-gate: 6/6`
- 真实与隔离 profile 字节同步通过。
