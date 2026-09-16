# Saker v0.2.8

本版聚焦真实运行缺陷、隔离边界与交付卫生；所有修复均配套回归测试，并在隔离 `DSH_HOME` 的 dsh 宿主上用 Chrome for Testing 做页面验收。

## 数据完整性

- `dsh-redteam-results` 禁止登记工具直接写入 `verified`，必须先登记再经独立二次评级回写。
- `dsh-hunter` 的 L1 实测回写补齐 `secondRating` 与足量复核依据。
- 修复链路对账在悬挂引用超过 12 条时的渲染异常。

## 运行与隔离

- `dsh-mcp-studio` 代理连接在命令、URL、参数或环境变化时正确重建。
- `dsh-semgrep-audit` 从当前 `preset/code-audit/refs` 布局定位规则集。
- `dsh-route-boost` 注入量记账跟随 `$DSH_HOME`。
- `dsh-session-pulse` 支持当前 `session.v3.jsonl.zstd` 会话文件。
- `dsh-scanner-tools` / `dsh-semgrep-audit` 的二进制探测兼容 Windows 的 `Path` / 缺失 `PATHEXT` 环境。
- `dsh-scanner-tools` 的证据与对账写入改为跨进程串行。

## WebShell 与界面

- 修复 `dsh-webshell-mgr` 的内存马命令通道、生成物删除和宿主 settings schema 注册。
- `dsh-skill-browse` 设置页补齐 `ctf-solver` 筛选。

## 测试与文档

- `failed` 在目标契约、报告门和恢复盘中统一按有效终态处理。
- 行为锁改用仓库相对路径并纳入全量测试。
- 补齐 Windows 环境下的环境变量/二进制探测测试。
- 同步当前三专业模式说明、插件版本、安装示例与生成物忽略规则。
