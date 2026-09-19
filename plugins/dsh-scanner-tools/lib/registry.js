// dsh-scanner-tools 工具注册表——声明式 CLI 参数模型（每个工具一个 def，新增工具只加一行数据）：
//   name/summary/params   工具注册面（defineTool 的名称/摘要/参数 schema；workspace 与 extra 由注册循环统一附加）
//   args.flags            命名参数 → CLI flag（值型；含 shell 元字符拒绝；required 可标）
//   args.combined         数值型参数（flag + 数值；def=保守默认；audited=true 显式覆盖进证据留痕；max=保守上限护栏）
//   args.switches         布尔开关（true 才拼入；白名单外开关走 extra 且留痕）
//   positional            位置参数名（append 到 argv 尾部）
//   defaults              保守默认参数（安全第一：连接扫描免 root / 限速 / 非交互 / 最小强度）
//   additional=extra      逃生门参数——显式附加参数，进证据留痕（不静默）
//   tiers                 六节点工具调用阶梯（本机 → MCP → 已装替代 → MCP 备选 → 问装 → 脚本编写）
//   limits                超时与输出预览上限
//   guard.active          true=主动扫描（防盲打：目标须已登记 assets.md / cloud-assets.md）；targetParam=防盲打取哪个参数当目标

const NO_SHELL_META = /[;&|`$><\n]/;

export const TOOL_DEFS = {
	katana: {
		id: "katana", bin: "katana", name: "katana_crawl", kind: "crawl",
		summary: "Web 爬虫与 JS/API 端点发现（katana；默认深度 3、限速 20）。目标须登记。",
		hint: "爬虫/入口面盘点：从已授权入口抓取链接、JS 引用和 API 候选；默认 -d 3 -rl 20 保守，不主动提交表单。",
		params: {
			target: { type: "string", required: true, description: "Target URL (must be registered in the asset baseline)" },
			depth: { type: "integer", description: "crawl depth (default 3, max 5; override is audit-logged)" },
			rate: { type: "integer", description: "requests/sec (default 20, max 100; override is audit-logged)" }
		},
		tiers: [
			"本机 katana（本工具）",
			"MCP 通道：已连接 MCP 内的爬虫/端点发现类工具",
			"已装可代替工具：gau_urls（被动 URL）+ httpx_probe（存活面）",
			"MCP 备选通道：其他已连接 MCP 内等价爬虫工具",
			"询问用户是否安装 katana（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：从已抓页面提取 a/href/script 并使用 requests 做同源广度遍历（登记 tool-plane「脚本代替 katana」）"
		],
		args: {
			flags: {
				target: { flag: "-u", required: true, desc: "Target URL" }
			},
			combined: {
				depth: { flag: "-d", type: "number", def: 3, max: 5, audited: true },
				rate: { flag: "-rl", type: "number", def: 20, max: 100, audited: true }
			},
			switches: {}
		},
		defaults: ["-jsonl", "-silent", "-nc"],
		limits: { timeoutMs: 600_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	afrog: {
		id: "afrog", bin: "afrog", name: "afrog_scan", kind: "vuln-scan", positional: null,
		summary: "模板漏洞扫描（afrog；默认仅 high/critical，限速 20、并发 5）。目标须登记。",
		hint: "模板漏洞扫描：与 nuclei 同域，afrog 默认只跑高危及严重，HTML 报告关闭、JSON 由本工具统一落盘；请求速率保守。",
		params: {
			target: { type: "string", required: true, description: "Target URL/host (must be registered)" },
			severity: { type: "string", description: "default high,critical; supports info,low,medium,high,critical" },
			rate: { type: "integer", description: "requests/sec (default 20, max 100; override is audit-logged)" },
			concurrency: { type: "integer", description: "PoC concurrency (default 5, max 20; override is audit-logged)" }
		},
		tiers: [
			"本机 afrog（本工具）",
			"MCP 通道：已连接 MCP 内的模板扫描类工具",
			"已装可代替工具：nuclei_scan（本插件已封装，模板面互补）",
			"MCP 备选通道：其他已连接 MCP 内等价扫描工具",
			"询问用户是否安装 afrog（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：按已知指纹选择公开 POC 并手工最小化验证（登记 tool-plane「脚本代替 afrog」）"
		],
		args: {
			flags: {
				target: { flag: "-t", type: "string", required: true },
				severity: { flag: "-S", type: "string", default: "high,critical" }
			},
			combined: {
				rate: { flag: "-rl", type: "number", def: 20, max: 100, audited: true },
				concurrency: { flag: "-c", type: "number", def: 5, max: 20, audited: true }
			},
			switches: {}
		},
		defaults: ["-doh", "-silent", "-nc"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	fscan: {
		id: "fscan", bin: "fscan", name: "fscan_portscan", kind: "portscan", positional: null,
		summary: "内网端口/服务发现（fscan；关闭 POC/爆破/Redis 利用，默认 20 线程）。目标须登记。",
		hint: "内网快速资产发现：默认 -np -nopoc -nobr -noredis 只做存活与端口/服务，避免把扫描器当利用器；大规模网段按授权范围使用。",
		params: {
			target: { type: "string", required: true, description: "Target host/CIDR/file (must be registered)" },
			ports: { type: "string", description: "Ports, e.g. 80,443,1000-2000; omitted uses fscan default top ports" },
			threads: { type: "integer", description: "module threads (default 20, max 50; override is audit-logged)" }
		},
		tiers: [
			"本机 fscan（本工具）",
			"MCP 通道：已连接 MCP 内的内网扫描类工具",
			"已装可代替工具：nmap_portscan / masscan_portscan（本插件已封装）",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 fscan（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：分段 TCP 连接探测 + 服务指纹脚本（登记 tool-plane「脚本代替 fscan」）"
		],
		args: {
			flags: {
				target: { flag: "-h", type: "string", required: true },
				ports: { flag: "-p", type: "string" }
			},
			combined: { threads: { flag: "-mt", type: "number", def: 20, max: 50, audited: true } },
			switches: {}
		},
		defaults: ["-np", "-nopoc", "-nobr", "-noredis", "-nocolor", "-no"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	nmap: {
		id: "nmap", bin: "nmap", name: "nmap_portscan", kind: "portscan", positional: "target",
		summary: "端口/服务扫描（nmap；默认 -Pn -sT -sV --max-rate 1000）。目标须在资产基线登记。",
		hint: "端口/服务扫描：-sT 连接扫描（免 root）+ -sV 服务版本，默认 --max-rate 1000 保守限速",
		params: {
			target: { type: "string", required: true, description: "Target host/IP (must be registered in the asset baseline)" },
			ports: { type: "string", description: "Port range, e.g. 80,443,1000-2000 (default top 1000)" },
			scripts: { type: "string", description: "NSE script set (caution: heavy; off by default)" },
			rate: { type: "integer", description: "max-rate override (default 1000 conservative; override is audit-logged)" }
		},
		tiers: [
			"本机 nmap（本工具）",
			"MCP 通道：已连接 MCP 内的 nmap/端口扫描类工具（如 kali MCP）",
			"已装可代替工具：masscan 顶端口扫 / rustscan（+ 手动服务指纹）",
			"MCP 备选通道：其他已连接 MCP 内等价探测工具",
			"询问用户是否安装 nmap（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：bash /dev/tcp 端口探测、nc 循环等实现同等探测（登记 tool-plane「脚本代替 nmap」）"
		],
		args: {
			flags: {
				ports: { flag: "-p", type: "string" },
				scripts: { flag: "--script", type: "string" }
			},
			combined: { rate: { flag: "--max-rate", type: "number", def: 1000, max: 10000, audited: true } },
			switches: {}
		},
		defaults: ["-Pn", "-sT", "-sV"],
		limits: { timeoutMs: 300_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	masscan: {
		id: "masscan", bin: "masscan", name: "masscan_portscan", kind: "portscan", positional: "target",
		summary: "高速端口扫描（masscan；默认 --rate 1000，需 raw socket，无权限走 nmap 兜底）。目标须登记。",
		hint: "高速端口扫（全网段快筛用）：默认 --rate 1000 保守；需 raw socket 权限（sudo），无权限直接降级 nmap -sT",
		params: {
			target: { type: "string", required: true, description: "Target IP/CIDR, e.g. 10.0.0.0/24 (must be registered)" },
			ports: { type: "string", required: true, description: "Ports, e.g. 80,443,8080 or 1-65535" },
			rate: { type: "integer", description: "packets/sec override (default 1000 conservative, hard cap 5000; override is audit-logged)" }
		},
		tiers: [
			"本机 masscan（本工具，需 sudo/raw socket）",
			"MCP 通道：已连接 MCP 内的端口扫描类工具（如 kali MCP nmap/masscan）",
			"已装可代替工具：nmap -sT（免 root，速度慢但同效）/ rustscan",
			"MCP 备选通道：其他已连接 MCP 内等价探测工具",
			"询问用户是否安装 masscan（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：bash /dev/tcp 并行探测脚本（登记 tool-plane「脚本代替 masscan」）"
		],
		args: {
			flags: { ports: { flag: "-p", type: "string", required: true } },
			combined: { rate: { flag: "--rate", type: "number", def: 1000, max: 5000, audited: true } },
			switches: {}
		},
		defaults: [],
		limits: { timeoutMs: 600_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	subfinder: {
		id: "subfinder", bin: "subfinder", name: "subfinder_enum", kind: "subdomain", positional: null,
		summary: "被动子域枚举（subfinder；不触达目标）。结果回填资产基线。",
		hint: "被动子域枚举（多被动源聚合，不触达目标）",
		params: {
			domain: { type: "string", required: true, description: "Base domain, e.g. example.com" }
		},
		tiers: [
			"本机 subfinder（本工具）",
			"MCP 通道：已连接 MCP 内的子域枚举类工具",
			"已装可代替工具：amass enum -passive / assetfinder / dig NS+AXFR 探查",
			"MCP 备选通道：其他已连接 MCP 内等价枚举工具",
			"询问用户是否安装 subfinder（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：证书透明日志查询（crt.sh API curl 脚本）等被动枚举（登记 tool-plane「脚本代替 subfinder」）"
		],
		args: {
			flags: { domain: { flag: "-d", type: "string", required: true } },
			combined: {},
			switches: {}
		},
		defaults: ["-silent", "-timeout", "60"],
		limits: { timeoutMs: 300_000, previewChars: 6000 },
		guard: { active: false }
	},
	gau: {
		id: "gau", bin: "gau", name: "gau_urls", kind: "passive-urls", positional: "domain",
		summary: "被动 URL 采集（gau；公开档案，不触达目标）。用于 JS/API 面盘点。",
		hint: "被动 URL 历史收集（wayback/otx/commoncrawl 公开档案；入口面盘点与 JS 专线的弹药库）",
		params: {
			domain: { type: "string", required: true, description: "Domain, e.g. example.com" },
			providers: { type: "string", description: "Archive providers, e.g. wayback,otx,commoncrawl" },
			threads: { type: "integer", description: "fetch threads (default 5 conservative, cap 20; override is audit-logged)" }
		},
		tiers: [
			"本机 gau（本工具）",
			"MCP 通道：已连接 MCP 内的 URL 历史类工具",
			"已装可代替工具：waybackurls / hakrawler 被动档",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 gau（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：web.archive.org CDX API curl 脚本（登记 tool-plane「脚本代替 gau」）"
		],
		args: {
			flags: { providers: { flag: "--providers", type: "string" } },
			combined: { threads: { flag: "--threads", type: "number", def: 5, max: 20, audited: true } },
			switches: {}
		},
		defaults: [],
		limits: { timeoutMs: 300_000, previewChars: 6000 },
		guard: { active: false }
	},
	whatweb: {
		id: "whatweb", bin: "whatweb", name: "whatweb_fingerprint", kind: "fingerprint", positional: "target",
		summary: "轻量 Web 指纹（whatweb -a 1）。可探测未登记目标，结果回填资产基线。",
		hint: "轻量 Web 指纹（默认 -a 1 保守；回填资产基线）",
		params: {
			target: { type: "string", required: true, description: "Target URL/host" },
			aggression: { type: "integer", description: "1-3 (default 1 conservative; 3 = more active, may trigger alerts; override is audit-logged)" }
		},
		tiers: [
			"本机 whatweb（本工具）",
			"MCP 通道：已连接 MCP 内的指纹识别类工具",
			"已装可代替工具：httpx_probe -tech-detect（本插件已封装）/ wappalyzer CLI",
			"MCP 备选通道：其他已连接 MCP 内等价指纹工具",
			"询问用户是否安装 whatweb（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：curl 抓响应头/指纹特征 + 手工比对（登记 tool-plane「脚本代替 whatweb」）"
		],
		args: {
			flags: {},
			combined: { aggression: { flag: "-a", type: "number", def: 1, max: 3, audited: true } },
			switches: {}
		},
		defaults: ["--no-errors", "--color=never"],
		limits: { timeoutMs: 180_000, previewChars: 6000 },
		guard: { active: false }
	},
	wafw00f: {
		id: "wafw00f", bin: "wafw00f", name: "wafw00f_detect", kind: "waf", positional: "target",
		summary: "WAF 识别（wafw00f -a）。活跃测试前先做防护画像。",
		hint: "WAF 识别：防护画像阶段先判 WAF（速率预算与打法据此定——playbook 防护画像前置 doctrine 的工具落地）",
		params: {
			target: { type: "string", required: true, description: "Target URL/host" }
		},
		tiers: [
			"本机 wafw00f（本工具）",
			"MCP 通道：已连接 MCP 内的 WAF 识别类工具",
			"已装可代替工具：whatweb -a 3（部分识别）/ httpx 安全头侧判 + 手工 payload 探测（最小化）",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 wafw00f（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：发送典型触发 payload 观察拦截页特征（最小次数，登记 tool-plane「脚本代替 wafw00f」）"
		],
		args: {
			flags: {},
			combined: {},
			switches: {}
		},
		defaults: ["-a"],
		limits: { timeoutMs: 120_000, previewChars: 6000 },
		guard: { active: false }
	},
	dirsearch: {
		id: "dirsearch", bin: "dirsearch", name: "dirsearch_dirs", kind: "content-discovery", positional: null,
		summary: "目录/路径发现（dirsearch -t 10）。目标须登记，速率跟随 WAF 画像。",
		hint: "目录/路径发现（与 ffuf 同域：dirsearch=自带字典上手快，ffuf=可配性更强；速率在 WAF 画像之后定）",
		params: {
			url: { type: "string", required: true, description: "Target base URL (must be registered)" },
			extensions: { type: "string", description: "e.g. php,html,js" },
			wordlist: { type: "string", description: "Custom wordlist path (absolute or SecLists)" },
			threads: { type: "integer", description: "threads (default 10 conservative, cap 30; override is audit-logged)" }
		},
		tiers: [
			"本机 dirsearch（本工具）",
			"MCP 通道：已连接 MCP 内的目录枚举类工具",
			"已装可代替工具：ffuf_fuzz（本插件已封装，-w 自选字典）/ gobuster / wfuzz",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 dirsearch（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：python 字典循环 requests 探测（登记 tool-plane「脚本代替 dirsearch」）"
		],
		args: {
			flags: {
				url: { flag: "-u", type: "string", required: true },
				extensions: { flag: "-e", type: "string" },
				wordlist: { flag: "-w", type: "string" }
			},
			combined: { threads: { flag: "-t", type: "number", def: 10, max: 30, audited: true } },
			switches: { recursive: "-r" }
		},
		// `-q`（quiet-mode）+ `--no-color`：不加的话 dirsearch 会刷几万个进度条片段
		// （`\r` 回车覆盖，落到文件里就是 800KB 连成一行），真正的命中在**最后几行**。
		// 模型侧只拿到开头 6000 字的预览 → 只看到进度条，
		// 于是「扫到了 /.git/config 但模型看不见」。实测一次真实会话就这样漏掉一个面。
		defaults: ["-q", "--no-color"],
		limits: { timeoutMs: 600_000, previewChars: 6000 },
		guard: { active: true, targetParam: "url" }
	},
	sqlmap: {
		id: "sqlmap", bin: "sqlmap", name: "sqlmap_inject", kind: "sqli", positional: null,
		summary: "SQL 注入验证（sqlmap --batch，默认 level/risk/threads=1）。目标须登记；先走 banner/dbs/count，--dump/OS 操作仅显式请求。",
		hint: "注入验证：--batch 非交互、level/risk/threads 默认 1 最小强度；**数据最小化分级**——banner→dbs→count 逐级证明，--dump/--os-shell 仅用户明示后经 extra 留痕执行（playbook 敏感数据最小化纪律）",
		params: {
			url: { type: "string", required: true, description: "Target URL with the injectable parameter, e.g. http://host/page?id=1 (must be registered)" },
			data: { type: "string", description: "POST body (if any)" },
			cookie: { type: "string", description: "Session cookie for authenticated testing" },
			level: { type: "integer", description: "1-3 (default 1; higher = more injection points tested; override is audit-logged)" },
			risk: { type: "integer", description: "1-3 (default 1; 2-3 include OR/time-based which are heavier; override is audit-logged)" },
			threads: { type: "integer", description: "concurrency (default 1 conservative, cap 5; override is audit-logged)" },
			dbs: { type: "boolean", description: "--dbs enumerate databases (escalation step)" },
			tables: { type: "boolean", description: "--tables enumerate tables (with --dbs or -D)" },
			count: { type: "boolean", description: "--counts row counts (minimal-impact proof of depth)" },
			banner: { type: "boolean", description: "--banner DBMS banner (minimal proof)" },
			forms: { type: "boolean", description: "--forms parse & test forms on the page" }
		},
		tiers: [
			"本机 sqlmap（本工具）",
			"MCP 通道：已连接 MCP 内的注入验证类工具",
			"已装可代替工具：nuclei sqli 模板（本插件 nuclei_scan -severity 可筛）+ 手工 payload 验证（sqlmap 定位后手工最小化复现）",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 sqlmap（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：python requests 手工注入验证脚本（时间盲注延迟判据等，登记 tool-plane「脚本代替 sqlmap」）"
		],
		args: {
			flags: {
				url: { flag: "-u", type: "string", required: true },
				data: { flag: "--data", type: "string" },
				cookie: { flag: "--cookie", type: "string" }
			},
			combined: {
				level: { flag: "--level", type: "number", def: 1, max: 3, audited: true },
				risk: { flag: "--risk", type: "number", def: 1, max: 3, audited: true },
				threads: { flag: "--threads", type: "number", def: 1, max: 5, audited: true }
			},
			switches: { dbs: "--dbs", tables: "--tables", count: "--count", banner: "--banner", forms: "--forms" }
		},
		defaults: ["--batch"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "url" }
	},
	nikto: {
		id: "nikto", bin: "nikto", name: "nikto_scan", kind: "webserver-scan", positional: null,
		summary: "Web 服务器配置扫描（nikto，非交互，噪声大）。目标须登记。",
		hint: "Web 服务器配置类扫描（与 nuclei 分工：nikto=服务器配置/已知问题，nuclei=模板漏洞；噪声大，授权与速率纪律适用）",
		params: {
			host: { type: "string", required: true, description: "Target URL/host (must be registered)" },
			tuning: { type: "string", description: "Scan tuning, e.g. 1,2,3 (info/file/default) — narrower = less noisy" },
			ssl: { type: "boolean", description: "force SSL" }
		},
		tiers: [
			"本机 nikto（本工具）",
			"MCP 通道：已连接 MCP 内的 Web 扫描类工具",
			"已装可代替工具：nuclei_scan（本插件已封装——模板覆盖大量同域检查，噪声更低）",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 nikto（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：curl 探测已知配置路径/响应头核查脚本（登记 tool-plane「脚本代替 nikto」）"
		],
		args: {
			flags: { host: { flag: "-h", type: "string", required: true }, tuning: { flag: "-Tuning", type: "string" } },
			combined: {},
			switches: { ssl: "-ssl" }
		},
		defaults: ["-nointeractive"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "host" }
	},
	hydra: {
		id: "hydra", bin: "hydra", name: "hydra_brute", kind: "brute", positional: "target",
		summary: "登录爆破（hydra -t 4，首中即停）。目标须登记；先验硬编码/已知凭据，并注意锁定策略。",
		hint: "登录爆破（默认 -t 4 保守+首中即停）：**硬编码凭据优先**——先走 JS/配置中的已获凭据与字典候选，爆破是后位手段；锁定策略与速率纪律适用",
		params: {
			target: { type: "string", required: true, description: "Target host + service, e.g. '10.0.0.5 ssh' / '10.0.0.5 rdp' / 'http-post-form 填模块串'（组合位置参数）" },
			login: { type: "string", description: "single username (-l)" },
			loginFile: { type: "string", description: "username list file (-L)" },
			passFile: { type: "string", description: "password list file (-P, absolute path)" },
			port: { type: "string", description: "port if non-default (-s)" },
			threads: { type: "integer", description: "parallel tasks (default 4 conservative, cap 16; override is audit-logged)" }
		},
		tiers: [
			"本机 hydra（本工具）",
			"MCP 通道：已连接 MCP 内的爆破类工具（如 kali MCP）",
			"已装可代替工具：medusa / ncrack",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 hydra（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：python 小字典循环 + 锁定感知（失败 N 次即停，登记 tool-plane「脚本代替 hydra」）"
		],
		args: {
			flags: {
				login: { flag: "-l", type: "string" },
				loginFile: { flag: "-L", type: "string" },
				passFile: { flag: "-P", type: "string" },
				port: { flag: "-s", type: "string" }
			},
			combined: { threads: { flag: "-t", type: "number", def: 4, max: 16, audited: true } },
			switches: {}
		},
		defaults: ["-f"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	impacket: {
		id: "impacket", bin: "impacket", bins: ["impacket-{module}", "{module}.py"], name: "impacket_suite", kind: "ad-exec", positional: "target", moduleParam: "module",
		summary: "Impacket AD 工具（secretsdump / psexec / wmiexec / smbexec / atexec / GetUserSPNs / GetNPUsers）。目标须登记；优先用已获凭据/哈希。",
		hint: "AD 重兵器套件：secretsdump 凭据直取（DCSync 单请求优于批量登录）、psexec/wmiexec/smbexec/atexec 横向执行（痕迹管理纪律适用）、GetUserSPNs/GetNPUsers Roasting 线起点；双安装名自动解析",
		params: {
			module: { type: "string", required: true, enum: ["secretsdump", "psexec", "wmiexec", "smbexec", "atexec", "GetUserSPNs", "GetNPUsers"], description: "Impacket module to run" },
			target: { type: "string", required: true, description: "Module target, e.g. 'DOMAIN/user@10.0.0.5'（secretsdump/exec 线）或 'DC.DOMAIN/user -dc-ip 由 dcIp 参数给'（Roasting 线）" },
			hashes: { type: "string", description: "NTLM hash auth ':NTLMHASH' or 'LM:NT'（pass-the-hash）" },
			dcIp: { type: "string", description: "domain controller IP (-dc-ip，Roasting/域线用)" }
		},
		tiers: [
			"本机 impacket（本工具——impacket-<module> / <module>.py 双名自动解析）",
			"MCP 通道：kali MCP（impacket 全家）",
			"已装可代替工具：netexec/crackmapexec（--sam 凭据线）；secretsdump→reg save 三件套离线解",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 impacket（pip 装于工作区 venv，征得批准后——本工具绝不自动安装）",
			"不批准则脚本编写：python impacket 库直接调用（venv 内）或手工协议（登记 tool-plane「脚本代替 impacket」）"
		],
		args: {
			flags: { hashes: { flag: "-hashes", type: "string" }, dcIp: { flag: "-dc-ip", type: "string" } },
			combined: {},
			switches: {}
		},
		defaults: [],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	netexec: {
		id: "netexec", bin: "netexec", bins: ["netexec", "nxc"], name: "netexec_scan", kind: "ad-recon", positional: "target", prefixParam: "protocol",
		summary: "AD 协议验证与枚举（netexec -t 10；支持 sam/shares/users/sessions/pass-pol）。目标须登记，注意锁定策略。",
		hint: "AD 协议验证喷洒：凭据候选有效性批量验证 + 态势枚举（SAM/共享/会话/密码策略）；**锁定意识**——用已获凭据候选定向验证而非 bulk；与 crackmapexec 同语法互为替代",
		params: {
			protocol: { type: "string", required: true, enum: ["smb", "winrm", "ldap", "ssh", "mssql"], description: "Target protocol" },
			target: { type: "string", required: true, description: "Host or CIDR, e.g. 10.0.0.0/24（must be registered）" },
			user: { type: "string", description: "username (-u)" },
			pass: { type: "string", description: "password (-p)" },
			hashes: { type: "string", description: "NTLM hash auth (--hashes ':NTLMHASH')" },
			threads: { type: "integer", description: "threads (default 10 conservative, cap 50; override is audit-logged)" },
			sam: { type: "boolean", description: "--sam dump SAM hashes (admin required)" },
			shares: { type: "boolean", description: "--shares enumerate shares" },
			users: { type: "boolean", description: "--users enumerate domain users" },
			sessions: { type: "boolean", description: "--sessions active sessions" },
			passPol: { type: "boolean", description: "--pass-pol password policy（锁定阈值侦察——爆破前置）" }
		},
		tiers: [
			"本机 netexec / nxc（本工具）",
			"MCP 通道：kali MCP（netexec/重武器库）",
			"已装可代替工具：crackmapexec（原版同语法）/ evil-winrm（winrm 线）",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 netexec（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：python 定向凭据验证循环 + 锁定感知（登记 tool-plane「脚本代替 netexec」）"
		],
		args: {
			flags: { user: { flag: "-u", type: "string" }, pass: { flag: "-p", type: "string" }, hashes: { flag: "--hashes", type: "string" } },
			combined: { threads: { flag: "-t", type: "number", def: 10, max: 50, audited: true } },
			switches: { sam: "--sam", shares: "--shares", users: "--users", sessions: "--sessions", passPol: "--pass-pol" }
		},
		defaults: [],
		limits: { timeoutMs: 600_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	crackmapexec: {
		id: "crackmapexec", bin: "crackmapexec", bins: ["crackmapexec", "cme"], name: "crackmapexec_scan", kind: "ad-recon", positional: "target", prefixParam: "protocol",
		summary: "AD 协议验证与枚举（CrackMapExec，同 netexec 语法，已停更；优先 netexec）。目标须登记。",
		hint: "AD 协议验证喷洒（原版，与 netexec 同语法互为替代；原版已停更——优先 netexec，本件为已装环境兼容）",
		params: {
			protocol: { type: "string", required: true, enum: ["smb", "winrm", "ldap", "ssh", "mssql"], description: "Target protocol" },
			target: { type: "string", required: true, description: "Host or CIDR（must be registered）" },
			user: { type: "string", description: "username (-u)" },
			pass: { type: "string", description: "password (-p)" },
			hashes: { type: "string", description: "NTLM hash auth (--hashes ':NTLMHASH')" },
			threads: { type: "integer", description: "threads (default 10 conservative, cap 50; override is audit-logged)" },
			sam: { type: "boolean", description: "--sam dump SAM hashes (admin required)" },
			shares: { type: "boolean", description: "--shares enumerate shares" },
			users: { type: "boolean", description: "--users enumerate domain users" },
			sessions: { type: "boolean", description: "--sessions active sessions" },
			passPol: { type: "boolean", description: "--pass-pol password policy（锁定阈值侦察——爆破前置）" }
		},
		tiers: [
			"本机 crackmapexec / cme（本工具）",
			"MCP 通道：kali MCP（重武器库）",
			"已装可代替工具：netexec（维护中的同语法继任者，优先）",
			"MCP 备选通道：其他已连接 MCP 内等价工具",
			"询问用户是否安装 crackmapexec（征得批准后安装——本工具绝不自动安装）",
			"不批准则脚本编写：python 定向凭据验证循环 + 锁定感知（登记 tool-plane「脚本代替 crackmapexec」）"
		],
		args: {
			flags: { user: { flag: "-u", type: "string" }, pass: { flag: "-p", type: "string" }, hashes: { flag: "--hashes", type: "string" } },
			combined: { threads: { flag: "-t", type: "number", def: 10, max: 50, audited: true } },
			switches: { sam: "--sam", shares: "--shares", users: "--users", sessions: "--sessions", passPol: "--pass-pol" }
		},
		defaults: [],
		limits: { timeoutMs: 600_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	}
};

function optionalToolTiers(localTool, mcpDomain, installedAlternative, scriptFallback) {
	return [
		`本机 ${localTool}（可选工具；未安装时不注册，不占模型工具面）`,
		`MCP 通道：已连接 MCP 内的${mcpDomain}`,
		`已装可代替工具：${installedAlternative}`,
		"MCP 备选通道：其他已连接 MCP 内等价工具",
		`询问用户是否安装 ${localTool}（征得批准后安装——本工具绝不自动安装）`,
		`不批准则脚本编写：${scriptFallback}`
	];
}

/**
 * Optional capability definitions stay dormant until the binary is installed.
 * This follows the source comparison against HexStrike's broad tool list without
 * paying its always-on schema cost on a machine that has none of the tools.
 */
export const OPTIONAL_TOOL_DEFS = {
	prowler: {
		id: "prowler",
		bin: "prowler",
		name: "prowler_cloud_audit",
		kind: "cloud-audit",
		optional: true,
		positional: "provider",
		summary: "云配置审计（Prowler；按 provider/profile/region 只读评估）。仅在已安装时暴露。",
		hint: "云配置基线检查：优先只读审计，凭据由调用方所在环境提供；结果落盘后按云资产与 IAM 面复核。",
		params: {
			provider: { type: "string", required: true, enum: ["aws", "azure", "gcp", "kubernetes", "m365"], description: "Cloud provider to audit" },
			profile: { type: "string", description: "Named cloud profile" },
			region: { type: "string", description: "Provider region" },
			checks: { type: "string", description: "Comma-separated check IDs (default: provider profile)" }
		},
		tiers: optionalToolTiers("prowler", "云配置审计工具", "云厂商 CLI + 手工基线脚本", "调用云厂商只读 API 检查核心 IAM/存储/日志配置"),
		args: {
			flags: {
				profile: { flag: "--profile", type: "string" },
				region: { flag: "--region", type: "string" },
				checks: { flag: "--checks", type: "string" }
			},
			combined: {},
			switches: {}
		},
		defaults: ["--output-formats", "json-ocsf"],
		limits: { timeoutMs: 1_800_000, previewChars: 6000 },
		guard: { active: false }
	},
	trivy: {
		id: "trivy",
		bin: "trivy",
		name: "trivy_scan",
		kind: "cloud-container",
		optional: true,
		prefixParam: "scan_type",
		positional: "target",
		summary: "容器/IaC/依赖/密钥扫描（Trivy；默认 JSON、vuln+misconfig+secret）。仅在已安装时暴露。",
		hint: "云原生供应链检查：fs/repo/image/config/k8s 分型，默认只读并输出 JSON；镜像扫描前确认本地镜像或授权 registry。",
		params: {
			scan_type: { type: "string", required: true, enum: ["fs", "repo", "image", "config", "k8s", "aws"], description: "Trivy target type" },
			target: { type: "string", required: true, description: "Path, repository, image, or authorized cloud target" },
			severity: { type: "string", description: "Comma-separated severities" }
		},
		tiers: optionalToolTiers("trivy", "容器/IaC/依赖扫描工具", "grype / syft / checkov", "对依赖锁文件、Dockerfile、K8s YAML 做本地规则与 CVE 比对"),
		args: {
			flags: { severity: { flag: "--severity", type: "string" } },
			combined: {},
			switches: {}
		},
		defaults: ["--format", "json", "--quiet"],
		limits: { timeoutMs: 1_200_000, previewChars: 6000 },
		guard: { active: false }
	},
	checkov: {
		id: "checkov",
		bin: "checkov",
		name: "checkov_iac_scan",
		kind: "iac",
		optional: true,
		summary: "IaC 安全审计（Checkov；对目录做 JSON 静态检查）。仅在已安装时暴露。",
		hint: "Terraform/CloudFormation/K8s/容器 IaC 静态检查；不改文件、不发布云资源。",
		params: {
			directory: { type: "string", required: true, description: "IaC directory to scan" },
			framework: { type: "string", description: "Optional framework selector" }
		},
		tiers: optionalToolTiers("checkov", "IaC 静态审计工具", "terrascan / trivy config", "解析 Terraform、CloudFormation 与 K8s YAML 并核对高危配置"),
		args: {
			flags: {
				directory: { flag: "-d", type: "string", required: true },
				framework: { flag: "--framework", type: "string" }
			},
			combined: {},
			switches: {}
		},
		defaults: ["-o", "json", "--compact", "--quiet"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: false }
	},
	"kube-hunter": {
		id: "kube-hunter",
		bin: "kube-hunter",
		name: "kube_hunter_scan",
		kind: "kubernetes",
		optional: true,
		summary: "Kubernetes 攻击面扫描（kube-hunter；远程目标须登记）。仅在已安装时暴露。",
		hint: "K8s 暴露面与错误配置检查：只对授权集群/主机使用，默认 JSON 报告；先确认 API Server、kubelet 与 etcd 范围。",
		params: {
			target: { type: "string", required: true, description: "Authorized Kubernetes host/CIDR" }
		},
		tiers: optionalToolTiers("kube-hunter", "Kubernetes 安全扫描工具", "kubescape / kube-bench / trivy k8s", "调用 K8s API 与常见端口做最小只读配置核查"),
		args: {
			flags: { target: { flag: "--remote", type: "string", required: true } },
			combined: {},
			switches: {}
		},
		defaults: ["--report", "json"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	arjun: {
		id: "arjun",
		bin: "arjun",
		name: "arjun_params",
		kind: "parameter-discovery",
		optional: true,
		summary: "HTTP 参数发现（Arjun；默认 GET、稳定模式）。目标须登记。仅在已安装时暴露。",
		hint: "隐藏参数发现：浏览器/代理已获得授权流量后再用；默认 GET、保守稳定模式，速率由目标承受能力与 WAF 画像决定。",
		params: {
			url: { type: "string", required: true, description: "Authorized target URL (must be registered)" },
			method: { type: "string", enum: ["GET", "POST", "JSON", "XML"], description: "HTTP method (default GET)" }
		},
		tiers: optionalToolTiers("arjun", "HTTP 参数发现工具", "x8 / paramspider / ffuf param", "从已抓请求与 JS 中提取参数名，再以小批量请求确认是否存在"),
		args: {
			flags: {
				url: { flag: "-u", type: "string", required: true },
				method: { flag: "-m", type: "string", default: "GET" }
			},
			combined: {},
			switches: {}
		},
		defaults: ["--stable"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "url" }
	},
	dalfox: {
		id: "dalfox",
		bin: "dalfox",
		name: "dalfox_xss",
		kind: "xss",
		optional: true,
		positional: "target",
		summary: "XSS 验证扫描（Dalfox；JSON、静默）。目标须登记。仅在已安装时暴露。",
		hint: "XSS 验证：先由已知注入点/参数构造目标，默认只验证不生成大规模盲打流量；命中仍需浏览器级复现。",
		params: {
			target: { type: "string", required: true, description: "Authorized URL with parameter (must be registered)" }
		},
		tiers: optionalToolTiers("dalfox", "XSS 验证工具", "xsstrike / 手工浏览器验证", "对已定位参数做编码上下文探测并用浏览器确认执行"),
		args: { flags: {}, combined: {}, switches: {} },
		defaults: ["url", "--format", "json", "--silence", "--no-spinner"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: true, targetParam: "target" }
	},
	volatility3: {
		id: "volatility3",
		bin: "volatility3",
		bins: ["volatility3", "volatility"],
		name: "volatility3_analyze",
		kind: "memory-forensics",
		optional: true,
		positional: "plugin",
		summary: "内存取证插件（Volatility 3；指定内存镜像与插件）。仅在已安装时暴露。",
		hint: "DFIR 内存分析：先做 windows.info/linux.pslist 等低风险信息插件，再按进程、网络、持久化时间线扩展。",
		params: {
			memory_file: { type: "string", required: true, description: "Memory image path" },
			plugin: { type: "string", required: true, description: "Volatility 3 plugin, e.g. windows.info" }
		},
		tiers: optionalToolTiers("Volatility 3", "内存取证工具", "Rekall / 内置 strings + 进程结构脚本", "结合符号与内存特征做进程/网络/持久化最小提取"),
		args: {
			flags: { memory_file: { flag: "-f", type: "string", required: true } },
			combined: {},
			switches: {}
		},
		defaults: [],
		limits: { timeoutMs: 1_800_000, previewChars: 6000 },
		guard: { active: false }
	},
	binwalk: {
		id: "binwalk",
		bin: "binwalk",
		name: "binwalk_analyze",
		kind: "firmware-forensics",
		optional: true,
		positional: "file",
		summary: "固件/复合文件结构识别（Binwalk；默认不自动解包）。仅在已安装时暴露。",
		hint: "固件与复合文件分析：默认只识别结构、不自动解包；需要提取时由模型显式使用 extra 并记录产物与磁盘影响。",
		params: {
			file: { type: "string", required: true, description: "Firmware or compound file path" }
		},
		tiers: optionalToolTiers("binwalk", "固件/文件结构识别工具", "file / foremost / 7z", "按 magic/文件头做结构识别并仅提取已确认的安全片段"),
		args: { flags: {}, combined: {}, switches: {} },
		defaults: ["--term"],
		limits: { timeoutMs: 900_000, previewChars: 6000 },
		guard: { active: false }
	}
};

for (const def of Object.values(OPTIONAL_TOOL_DEFS)) TOOL_DEFS[def.id] = def;

/** 由 def + 参数构建 argv：默认 → combined（含上限/留痕）→ flags（元字符拒绝）→ switches（布尔白名单）
 *  → positional → extra。返回 { argv, audit }——audit 为留痕行数组（保守默认时为空）。
 *  未知参数直接拒绝并列已知名（workspace/extra/switches 名也计入已知）。 */
export function buildArgs(def, params = {}) {
	const argv = [...def.defaults];
	const audit = [];
	const known = new Set(["workspace", "extra",
		...(def.positional ? [def.positional] : []),
		...(def.prefixParam ? [def.prefixParam] : []),
		...(def.moduleParam ? [def.moduleParam] : []),
		...Object.keys(def.args?.flags ?? {}),
		...Object.keys(def.args?.combined ?? {}),
		...Object.keys(def.args?.switches ?? {})]);
	for (const k of Object.keys(params)) {
		if (params[k] === undefined || params[k] === "") continue;
		if (!known.has(k)) throw new Error(`未知参数 ${k}（已知：${[...known].filter((x) => x !== "workspace" && x !== "extra").join("/")}/extra）`);
	}
	for (const [k, spec] of Object.entries(def.args?.combined ?? {})) {
		let v = params[k];
		if (v === undefined || v === "") v = spec.def;
		if (v === undefined) continue;
		const n = Number(v);
		if (!Number.isFinite(n) || n < 0) throw new Error(`参数 ${k} 须为非负数值`);
		if (spec.max !== undefined && n > spec.max) throw new Error(`参数 ${k}=${n} 超保守上限 ${spec.max}`);
		argv.push(spec.flag, String(n));
		if (spec.audited && String(v) !== String(spec.def)) audit.push(`${spec.flag} ${v}（默认 ${spec.def}，显式覆盖留痕）`);
	}
	for (const [k, spec] of Object.entries(def.args?.flags ?? {})) {
		const v = params[k] === undefined || params[k] === "" ? spec.default : params[k];
		if (v === undefined || v === "") {
			if (spec.required) throw new Error(`参数 ${k} 必填（${spec.desc ?? ""}）`);
			continue;
		}
		const s = String(v);
		if (NO_SHELL_META.test(s)) throw new Error(`参数 ${k} 含 shell 元字符，拒绝`);
		argv.push(spec.flag, s);
	}
	for (const [k, flag] of Object.entries(def.args?.switches ?? {})) {
		if (params[k] === true) argv.push(flag);
	}
	if (def.positional) {
		const t = params[def.positional];
		if (t === undefined || t === "") throw new Error(`参数 ${def.positional} 必填（扫描目标）`);
		if (NO_SHELL_META.test(String(t))) throw new Error(`目标含 shell 元字符，拒绝`);
		argv.push(String(t));
	}
	if (params.extra) {
		const s = String(params.extra);
		if (NO_SHELL_META.test(s)) throw new Error(`extra 含 shell 元字符，拒绝`);
		argv.push(...s.split(/\s+/).filter(Boolean));
		audit.push(`extra: ${s}（显式附加参数留痕）`);
	}
	if (def.moduleParam) {
		const mv = params[def.moduleParam];
		if (mv === undefined || mv === "") throw new Error(`参数 ${def.moduleParam} 必填`);
		const allowed = def.params?.[def.moduleParam]?.enum;
		if (allowed && !allowed.includes(String(mv))) throw new Error(`未知 ${def.moduleParam}：${mv}（合法：${allowed.join("/")}）`);
	}
	if (def.prefixParam) {
		const pv = params[def.prefixParam];
		if (pv === undefined || pv === "") throw new Error(`参数 ${def.prefixParam} 必填`);
		argv.unshift(String(pv)); // 协议名打头（nxc smb <target> 语法），目标与选项随其后
	}
	return { argv, audit };
}

/** 六节点阶梯文案（工具描述与缺装提示共用）。 */
export function tiersLine(def) {
	return "工具调用阶梯（缺失逐级降，每级有出口）：\n" + def.tiers.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
}

export { NO_SHELL_META };
