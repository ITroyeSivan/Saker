---
name: web-fuzz
description: Web 模糊测试与目录/参数枚举作战技能：路径/参数/隐藏接口/备份文件的发现。WAF 画像后定速率（无 WAF ≤12 并发/有 WAF ≤6），ffuf/dirsearch 主通道，wfuzz 备用；命中后接 burp 重放 + 人工验证。服务 pentest 的"未知路径"维度与 code-audit 的"接口面映射"维度。
tools: ffuf, dirsearch
---

# Web 模糊测试（web-fuzz）

> 位置：Saker 模式包 `shared/skills/`，各预设（pentest / code-audit）共同加载。
> 适用：未知路径/参数/隐藏接口/备份文件发现；CMS 主题/插件路径枚举；登录口参数面展开。

## 通道阶梯

| 场景 | 默认通道 | 降级链（缺失时） |
|---|---|---|
| 目录/路径枚举 | **ffuf**（速率灵活、过滤规则丰富） | dirsearch → wfuzz → gobuster → kali MCP |
| 文件后缀字典（备份 / 临时 / 压缩） | **ffuf** `-mc 200,403,500` 配 wordlist | curl 手动批量（小范围） |
| 参数 FUZZ（GET/POST） | **ffuf** `-X POST -d` / wfuzz | sqlmap tamper（仅当确认为注入面） |
| 子域 / vhost 枚举 | **subfinder**（被动优先） | amass → curl Host 头探测 |

## 速率纪律（与 pentest-playbook 同源）

- 探测 WAF 之前不允许跑批量：先用 `wafw00f` 或 `whatweb` 探明。
- 无 WAF：ffuf `-t 12`、dirsearch 默认线程。
- 有 WAF：ffuf `-t 6` + 随机 UA + 间隔 0.5–1.5s。
- 触发 429/5xx 立即停——记入防护画像卡，降速或转 IP/路径规避。

## 字典选择

- 默认：SecLists `Discovery/Web-Content/raft-medium-files.txt` + `raft-medium-directories.txt`。
- API 型：用 `api` 目录子集（保留 200/JSON 模式命中）。
- CMS 型：按 CMS 指纹加载 `CMS/<name>/` 子集。
- 备份文件：单跑一遍 `common-backups.txt` 即止，不重复。

## 落地产物

- **命中清单**：`scripts/<target>/fuzz-hits.md`——URL / 状态 / 字节数 / wordlist 来源。
- **防护画像更新**：`assets.md` 追加 WAF/限速观测。
- **隐藏接口**移交 `pentest-playbook` 形态作战线 A 或 `audit-playbook` 面映射。

## 纪律

- 字典加载前必看大小：超大字典（>100k）默认不跑，先缩到 top-5k 试一轮。
- 命中 ≠ 漏洞：每个命中要走 burp 人工确认响应内容/异常点。
- 备份/源码文件命中 = 严重线索：必走独立验证通道（curl + diff），不直接判 reading。
- 复测覆盖：同一字典同一目标不重复跑——落 evidence-index 防回扫。
