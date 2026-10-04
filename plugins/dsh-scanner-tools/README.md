# dsh-scanner-tools

pentest 三级兜底第一级的运行时化：本机 nuclei/httpx/ffuf 封装为模型工具，纪律内置。
挂载：**preset 平面**（pentest / attack-defense / cloud-security / ctf-solver 的 agent.cordis.yml 各一行；宿主层行见
cordis.patch.yml 注释，默认不启用——preset 平面分层）。

## 工具

| 工具 | 默认速率 | 防盲打 | 产物 |
|---|---|---|---|
| `nuclei_scan(target, workspace, severity?, rate?)` | -rl 15；默认排除 `intrusive` | 主动：须已登记 assets.md | 命中→scan-reconcile.md 待处置行（命中≠漏洞） |
| `httpx_probe(targets, workspace, rate?, favicon?)` | -rl 25 | 轻探测：允许未登记；title、server 与 technology hints 分开输出 | 存活/指纹 JSON；歧义时可选 `favicon=true` 多发一次 `/favicon.ico` 请求；不返回页面正文 |
| `ffuf_fuzz(url, workspace, mode, wordlist?, rate?)` | -rate 50 | 主动：须已登记 | -o JSON 直接入产物 |
| `asset_ingest(workspace, file/text, source, format?, scope?, authorized?)` | 不执行扫描 | 本地导入 | 归一进 `asset-inventory.json` + `assets.md` |

共同行为：
- Pentest 可用 `deferredTools` 将 Nmap、dirsearch、ffuf、Nuclei、Afrog、SQLMap、katana、gau
  从初始模型工具面移出。`tool_pack action=list/load/unload pack=active-scan` 只调整当前 Agent 的工具 schema；
  load 不会启动扫描，卸载或会话结束会移除这些 schema。常规测试只在已有明确假设时加载；Nday 默认不加载。
- 新增 `katana_crawl`：从已登记入口抓取链接、JS 引用和 API 候选，
  默认 `-d 3 -rl 20`，不主动提交表单。
- 新增 `afrog_scan`：默认只跑 high/critical，限速 20、并发 5。
- 新增 `fscan_portscan`：默认关闭 POC、爆破、Redis 利用和 ping，
  只做授权的存活/端口/服务发现。
- 可选工具按本机安装状态注册：`prowler`、`trivy`、`checkov`、
  `kube-hunter`、`arjun`、`dalfox`、`volatility3`、`binwalk`。
  未安装时不进入模型工具面；装好后重启宿主即可使用，避免把不可用 schema
  常驻在上下文里。
- 产物写 `<workspace>/artifacts/scans/<tool>-<ts>.json`，并回 `evidence-index.md` 一行
  （**速率注记**：默认值标注「保守默认」；显式 rate 覆盖会留「默认 X → Y，留痕」）。
- 若 `operation_intent` 登记了同负责人、正在排队的长时间任务，工具会自动领取并更新为
  成功或失败；不需要模型在调用前后手动调用 `operation_task`。
- **绝不自动安装**：缺二进制→三级兜底提示（本机→MCP→安装请求）；nuclei 模板库缺失→
  前置拦截并提示需用户批准一次性下载（`-update-templates`，数据非工具）。
- ffuf 字典必须显式给（wordlist 参数），不代装字典。
- **路径直连 sec-config**：扫描前按工具名读取「安全配置」里的 `entries` / `tools`
  绝对路径；配置了文件或目录就不再要求用户把工具额外塞进 `PATH`，配置路径失效时
  错误里会直接点名该路径，而不是伪装成“未安装”。
- **ffuf 回执可读**：命中从 `-o` JSON 抽回回执（状态码、大小、URL），模型不需要再额外读一次产物文件才能知道扫到了什么。
- **已有导出可消费**：`asset_ingest` 解析 TScanPlus/fscan/nmap/httpx 常见的 JSON、JSONL、CSV
  与文本输出，按统一资产 schema 合并；它是 GUI 工具没有稳定 CLI 时的正路，不把 TScanPlus
  假设成一个不存在的命令行。
- **katana 入参对齐 CLI**：目标固定走官方 `-u <url>`，不再把 URL 当位置参数导致 exit 0 但零输出。
- **Python 仓库类工具**：`sqlmap.py`、Impacket `*.py` 会经配置的 `python`
  （或 PATH 中的 Python）启动；配置入口失效时按 `roots` 找回正确套件脚本，
  多入口套件不会再把“任意一个 .py”误当成目标模块。
- **异步执行**：外部扫描器用异步子进程运行，长扫描不再用 `spawnSync`
  冻结宿主事件循环；超时与输出上限仍按每个工具的 `limits` 生效。
- **Nuclei 默认安全筛选**：广泛扫描排除 `intrusive` 标签；这类模板可能写文件或执行命令，需先按 Nday 线索人工核对具体模板及副作用。

## 测试

- `node test/run.mjs`：登记检查/无 assets 提示/缺二进制兜底提示/默认速率（5 项，全过）。
- 实机冒烟（DVWA 127.0.0.1:8081）：httpx 真跑通+证据落盘 ✓；ffuf 小字典真跑通+证据 ✓；
  防盲打拒绝 ✓；nuclei 模板缺失前置拦截 ✓（模板下载待用户批准，见 PROGRESS）。

Saker渗透预设设置 managedToolPacks: true，由 dsh-tool-scope 统一管理工具包；扫描器不再注册同名 tool_pack。独立安装默认保留扫描器自己的 active-scan 入口。工具隐藏需要统一插件实际生效，不能靠本项配置单独保证。
