# dsh-nday-hunter

把 Nday 语料变成动作：**批量指纹筛选 + 诚实的短名单 + 带外确认原语 + 交接单**。

开发版1.5.3：同批相同URL、方法及Host的请求只发送一次，各探针判据独立评估；随机对照计入总请求预算。模型默认显示前12条（`resultLimit`最多50），完整结果仍在台账。该批生产入口与官方运行时测试通过，桌面模型调用因隔离环境缺少凭据尚未通过；实战检出与token收益尚未证明。

开发版1.5.4：计划和筛查复用账本中的产品线索；默认筛查不再隐式跑全目录。未知产品每服务最多一次基线识别，每批至多32个未知服务；识别失败记录入口、认证、组件缺口。普通厂商词、域名、分析标签及Java/OA/nginx等通用词不选中产品。多个虚拟Host分别筛查，攻击计划由主代理负责。可用 `nday_priority_plan workspace=...` 复用画像；未知版本不被视为安全。该批受控生产入口、反向验证与真实宿主工具契约通过，桌面实际调用仍待凭据问题解决。

## 解决的问题

机构重复服务按实际应用分组：共享IP、同标题、同产品不自动合并。资产账本保留虚拟Host、协议、大小写敏感的路径和租户查询边界。同一实际服务的多来源记录仍合并；连接IP不会成为应用身份键。

可复用别名可提供 `applicationIdentity`：`id/deploymentRevision/routingContext/authBoundary/configDigest`、`verified=true`以及至少两条不同的 `evidenceIds`。这些字段必须来自已核对的部署与独立路由/行为观察；工具不会仅凭同指纹推导同一应用。字段不完整或证据缺失时，每项资产独立校准。配置摘要为64位SHA256；路由、身份边界、部署或配置不同均分组。

`attack_plan`输出schema 2，每个独立组绑定固定代表入口和组成员/部署/方法签名。旧校准不能解锁变化后的组；旧schema 1多资产桶也不再允许直接铺开，应重新生成计划并按当前证据校准。别名组只共享已确认部署与已审阅方法材料；每个入口独立核对当前身份、正常请求、适用条件及实际影响，代表入口结果不自动变成其他入口的漏洞或阴性结论。停止规则读取当前 `redteam_task`，不统一改成首个RCE。

2026-09 护网复盘里，冠军队伍用**信创的东方通一个 Nday** 拿下 8 个 shell；
我们当时既没有那类组件的知识（`refs/` 对信创零覆盖），**也没有把知识变成批量动作的能力**。
`refs/nday/` 补了前半截，本插件补后半截：

| 缺口 | 本插件怎么补 |
|---|---|
| 知道有漏洞，但不知道**哪些资产**符合指纹 | `nday_match` 拿一批资产 × 语料里**机器可判定**的探针，批量跑出短名单 |
| 现场目标很多，人工逐产品拼 FOFA 查询太慢 | `nday_scope_hunt` 按 RCE 优先组合目录显式指纹、GET/HEAD 响应签名、目录端口收窄和产品别名兜底，在授权范围内调用 FOFA；FOFA 不可用时自动降级到 Hunter/Quake，并保留“查询 → 条目 → 候选资产”映射 |
| 跑完一堆"疑似"没法判断可信度 | 每条命中带**证据强度**（weak/medium/strong）与逐探针理由；结论只到 `fingerprint-*` |
| 不知道下一步怎么确认 | 命中行直接给出条目 `exploit.tools` 里点名的**公开工具**，作为交接单 |
| 反序列化/盲 RCE/SSRF 这类面**只能用带外回连确认** | `oob_probe` 提供 DNSLog 带外通道：分配唯一子域 → 注入 → 回查，回连归因到本次测试 |
| 结果散落在聊天里 | 台账落 `artifacts/nday/*.json|.csv`，并回写 `evidence-index.md` 一行 |

## 工具

### `nday_priority_plan` / `nday_policy_get` / `nday_policy_set`

`nday_priority_plan` 不发网络请求、不带利用载荷；它把模型需要的判断框架一次性给出：

Nday匹配（含机构分支）应先调用它，再把排序后的 `entryIds` 交给 `nday_scope_hunt`，避免把配额浪费在全目录查询上。

`1.5.1` 开发改动：FOFA 查询保留 OR、括号、精确匹配和重复字段；机构身份条件按 OR 并集合并，约束整组产品指纹。无效语法显式列在 `rejectedHints`，不自动退成宽查询。排序使用实际披露日期及已核实的新 PoC/在野/绕过时间，日期未知保持未知；Java 线索会产生待补证的 Log4j 组件分支。默认单模型规划、批量工具，不按每个 CVE 派 worker。完整桌面与情报维护闭环仍在实施。

- 排序维度：近期窗口、CNVD/CVE、国产/信创、目标匹配、可达性、影响、EXP 成熟度、验证成本、社区热度；
- 情报来源：厂商公告、CNVD/CNNVD、CVE/NVD、GitHub、ExploitDB/Packet Storm/Metasploit、国内安全情报、微信公众号、目标自身证据；
- 收集雷达：结构化公告/编号源是主源，微信公众号是提前量；公众号线索必须回到公告、编号或 GitHub 交叉验证后才能升级为候选；
- FOFA 分层：精确产品/版本/body/header/icon_hash → app/title/body 产品级 → cert/ip/asn/icp/org 关联 → 蜜罐/欺诈/无关资产排除；
- 验证梯：被动候选 → 指纹 → 版本前提 → EXP 来源检索/补丁差分 → 最小验证/OOB → 证据；
- 执行：默认单模型规划、批量工具；并发值约束工具批次，独立且有证据的分支才按需委派。

已有目标证据时，可传 `verificationContext` JSON 字符串生成 `verificationQueue`。该队列与发现候选上限分开：历史高危有具体目标证据时继续保留，准备好请求和条件的入口优先，不同产品交错处理。

```json
{
  "assets": [{"id":"site","url":"https://example.com","inScope":true,"reachable":true}],
  "checks": [{
    "assetId":"site","entryId":"<目录条目ID>","endpoint":"https://example.com/api/import",
    "methodVersion":"v1","authContext":"anonymous","requestRevision":"baseline-v1",
    "productConfirmed":true,"productEvidenceIds":["product-response"],
    "conditions":[{"name":"component-version","state":"unknown"}],
    "requestValid":true,"baselineEvidenceIds":["normal-response"],"methodReviewed":true
  }],
  "history": [],
  "maxSupplementAttempts": 2
}
```

条件采用 `satisfied`、`not-applicable`、`unknown`；已知条件必须引用任务证据。入口必须与资产同源，范围或可达性未确认则受阻。未知条件进入有限补证，耗尽记覆盖缺口；空条件表也需要补证。有效业务请求、基线和方法审阅齐备后才规划最小检查与对照。

历史记录使用同一资产、条目、入口、身份、方法版本和请求基线作为键，附 `status`、`evidenceIds` 和 `supplementAttempts`。未命中还需 `requestValid:true`；网关拒绝不能当作阴性。身份、入口或基线变化使旧记录失效；重复历史键须先合并。`mechanism-confirmed` 与 `impact-confirmed` 仍须独立成果及复现复核，计划工具不把记录升级为已确认漏洞。身份字段使用稳定代号，凭据留在任务私有存储。

策略可用 `nday_policy_set` 结构化覆盖：`recentDays`、`domesticBoost`、`trendKeywords`、`excludeVendors`、`maxCandidates`、`queriesPerNday`、`concurrency`。

### `nday_source_fetch`

免费公开源适配器，返回候选记录而不是漏洞结论：

- `cisa-kev`：CISA 已知在野利用 JSON；
- `nvd`：NVD REST API，匿名可用但有限流；
- `osv`：OSV 公开 API，按漏洞编号或包生态/包名/版本查询；
- `github-advisories`：GitHub Global Security Advisories，匿名低配额可用，可选 token 只用于稳定高频；
- `nuclei`：读取 `projectdiscovery/nuclei-templates` 的公开 commit Atom feed，保留模板路径、提交时间、提交链接和编号；模板更新只是 PoC 线索；
- `wechat`：搜狗微信搜索页的 search-assisted 适配器，保留公众号、标题、摘要、日期和跳转链接；触发验证码时明确失败，不伪报零结果。

这些源都无需 API key；FOFA 是唯一在设置页要求 key 的资产搜索平台。公众号结果属于提前量，必须回到公告、编号或 GitHub 交叉验证。

来源状态由 `lib/source-registry.js` 明确区分，不能把“检索指引”说成“已接入接口”：

| 来源 | 当前状态 | 配置/入口 |
|---|---|---|
| FOFA / 奇安信 Hunter 资产测绘 / 360 Quake | 已接入 API | 设置 → 资产平台 API，key 只存本机 `hunter.db` |
| 阿里云漏洞库 AVD | 外部浏览器脚本 | `_ref/tools/avd-fetch.mjs`，需 Chrome for Testing |
| NVD / OSV / GitHub Advisories / CISA KEV / nuclei-templates | 已接入免费自动采集 | `nday_source_collect` 或设置页「漏洞情报更新」；勾选后直接更新，支持单源重试；定时更新默认停用 |
| CNVD / CNNVD | 宿主搜索或人工页面 | 验证码 / 账号权限限制，未做匿名抓取 |
| 奇安信 CERT / 国内情报站 | 仅来源指引 | 未找到并接入稳定免费 API；不要称其为已接入数据源 |
| 微信公众号 | search-assisted 自动检索 | 无官方开放搜索 API；配置检索词后由搜狗公开结果页采集，验证码会如实失败，必须交叉验证 |

### `nday_source_radar` / `nday_source_collect` / `nday_metrics`

- `nday_source_radar` 读取采集器配置、上次/下次运行、逐源成功/失败/跳过状态、合并候选和指标；失败源保留原始错误，不会伪装成零结果。
- `nday_source_collect` 可立即运行采集，或持久化 `sources`、`query`、`wechatQuery`、`lastDays`、`limit`、`intervalHours`、`enabled`。后台定时器每 15 分钟检查一次，只在到期且启用时发请求。
- `nday_metrics` 记录候选数、API 请求数、查询组数和批次命中信号；确认漏洞/RCE及复现率从当前成果库按会话、实际入口和机制去重计算，重复反馈不增加成果。查询到RCE耗时需要关联会话/成果ID。缺少唯一筛选与复核记录时，指纹误报率保持未知。
- 采集器默认停用，避免安装后未经同意访问外部免费源；在设置页启用后才会按间隔运行。候选会按编号、URL 或标题合并，并带 `trust`、`publishedAt`、`freshness`、`dedupKey`。

### `nday_catalog`

查语料。列表模式按 `keyword` / `status` / `product` / `category` 过滤；
给 `entryId` 返回单条详情——含影响版本、**验证要点**、可利用原语、交接工具、误报点、来源，
以及**同类资产扩面查询**：先用目录显式 FOFA 语法；缺少时才从已记录的 GET/HEAD 响应判据派生被动产品签名。响应签名只找候选，不代表版本受影响。

### `nday_scope_hunt`（FOFA 优先的范围内 Nday 检索）

```text
scope    : 本轮明确授权的域名、IP 或 IPv4 CIDR，必填
workspace: 任务工作区，必填
focus    : rce（默认）或 all
keyword / entryIds : 可选，限定产品、编号或条目
limit / offset : 每批最多 100 组；默认 20，返回 nextOffset 供继续
platform : auto（默认）/ fofa / hunter / quake；auto 依次尝试并在失败时降级
```

当前语料快照（更新于 2026-09-25）中，默认 RCE 计划筛出 69 条条目，生成 79 组去重查询：13 组来自目录显式指纹，17 组来自 GET/HEAD 探针响应签名，2 组由产品与目录端口收窄，47 组为产品别名兜底。默认首批 20 组只包含前 3 类高信号查询；其余组通过 `nextOffset` 分页。每次搜索与证据文件都会列出查询依据和目录覆盖质量。FOFA 请求串行限速，结果显示 API 请求数和预计耗时；API 字段权限不足、认证失败和其他查询错误单独记录，不会伪装成零候选。

FOFA 搜索是被动索引查询，不向目标发送请求。资产会在查询范围约束后再做本地范围过滤，产物只保留范围内候选。每个候选映射到对应的 Nday 条目和查询依据。测绘命中只代表产品/页面指纹候选，**不代表受影响版本、漏洞或 RCE**。

FOFA 不可用时，`platform=auto` 会按 FOFA → Hunter → Quake 降级；返回体和证据文件保留 `platformAttempts`、`degradedFrom` 和 `fieldWarnings`。Hunter/Quake 没有等价语法的字段（例如 `icon_hash`、`fid`、`cert.*` 等）会逐项标注，查询组可能被平台拒绝或降级，不会把降级后的宽查询说成原字段命中。

下一步用 `nday_match assetSource=nday-search searchId=<返回值> scope=<本轮授权范围> workspace=<任务工作区>`。它再次检查范围，并只探测匹配到的资产/条目组合；无效条目映射会被拒绝，不会退化为全目录探测。

### `nday_match`

```text
targets   : 逗号/换行分隔的 URL 或 host（无 scheme 默认 http://）
workspace : 工作区根（台账与 evidence-index 落这里）
assetSource : targets | inventory | nday-search；后者读取 nday_scope_hunt 搜索证据
searchId    : assetSource=nday-search 时必填
entryIds  : 可选，收窄到指定条目
timeoutMs / concurrency : 可选，速率纪律
rate      : 可选，每秒最多起几个请求（默认 15，硬上限 100）
```

**并发数不等于速率**：`concurrency` 只管「同时在飞几个」，不管「每秒发几个」——
并发 4 遇到 20ms 的响应就是 ~200 req/s，对着带 WAF 的目标就是自曝。
所以另有一道速率闸门，默认 **15 req/s**（与本仓库 nuclei 交接命令的 `-rl 15` 对齐），
每次发包前按 `1000/rate` 毫秒的间隔排队。调**低**只是更保守；
调**高**会在结果与台账里留下「显式放开：默认 15 → N req/s」的痕迹，模型侧文本也会写明生效速率。

对每个（资产 × 条目）执行条目里的 `fingerprint.probes`，按证据强度归并出结论：

```text
no-signal          一个探针都没命中
fingerprint-weak   只有路径存在性这类弱信号
fingerprint-medium 命中了内容特征
fingerprint-strong 命中了协议级可区分特征
```

**短名单按证据强度排**（`strong` → `medium` → `weak`），同级内按资产/条目名排序
——强命中埋在一堆弱命中下面等于没有短名单，操作者要从上百行里翻。同级内固定排序
也保证「同输入同输出」，便于对账与复跑。

**每条命中行还带一个 `expand` 字段**（扩面入口）：有目录语法或探针响应签名时给 `nday_scope_hunt` 的调用和依据；没有可用签名时如实说明无法反查。范围搜索中的产品别名与端口查询会单独标作兜底或收窄。命中之后可以先扩到同类候选，再筛目标。
这一行同时写进**模型实际读到的文本**里（`render` 只输出 `text`，结构化字段模型看不到）。

`attack_plan` 的输出也会带下一跳的收窄引导：**按桶跑**
（`nday_match assetSource=inventory entryIds=<该组 entryId>`）——不带 `entryIds` 全量跑
会撞上单次 **800 次探测**的上限（工具会直接拒绝并让你收窄）。

## 三条不可让步的纪律

1. **探针命中是筛选信号，不是漏洞结论。** 输出里不会出现 `confirmed` / `vulnerable`，
   `VERDICT` 枚举本身就被测试钉住（断言它不含 confirm/vuln 字样）。
2. **不投放利用载荷。** 语料里没有 payload，本插件也不生成 payload。
   stage-2 的确认交给条目里点名的公开工具（如 `CurlySean/TongWebExploit`），由模型/用户执行。
3. **报表如实。** 命中项里含 `normalized`（我方未复现）条目时，输出必须写明
   「尚未复现」，措辞不得写成"已确认可利用"。

另外：规模超限**明确拒绝**而不是静默截断（400 个目标 × N 条目的计划会直接报错并告诉你收窄）；
传输失败单独计数并说明"这些资产未计入命中，不等于不存在"。

**探针的传输层口径**（2026-09-25 实测修正）：探针用 `node:http/https` 直连，**不是全局 `fetch`**——

1. 目标侧自签/过期证书极其常见（内网信创系统、安全设备控制台）。`fetch` 会直接失败，
   批量筛查在这些目标上等于**整条不可用**（实测：自签名站点上探针 100% 传输失败、`rows` 为空），
   因此对 HTTPS **关闭证书校验**（与 `dsh-webshell-mgr` 同一口径）；
2. 一次性连接（`agent:false`）避开 keep-alive 复用导致部分目标偶发 404/500 的**假拒绝**；
3. 失败原因按 `error.code` 翻译成**可行动**的一句话（「连接被拒绝（端口未开放）」
   「目标端口不是 TLS（更像明文 HTTP 端口）」…），并在全部失败时把原因摘要写进输出——
   原先只有一句「超时/拒连」，会把证书问题带偏成"目标不可达"。
4. 响应体按 `Content-Type` 的 **charset 解码**（`gb2312` 归一到 `gbk`，无 charset 才用 UTF-8）：
   判据里有中文串（如金蝶 Apusic 欢迎页标题），而信创/国产系统大量返回 GBK——
  只按 UTF-8 解会让那类探针在真实目标上**永远打不中**（实测 GBK 靶子上命中数为 0）。
5. **同主机重定向跟随**（最多 2 跳；301/302/303 按浏览器语义降级为 GET，307/308 保持原方法）：
   内网/信创系统大量把 `http://` 301 到 `https://`、把 `/` 跳到 `/login`，
   不跟随的话 body 类判据拿到的是**空响应体**（实测同主机 301 靶子上命中数为 0）。
   **跨主机一律不跟随**——跟随到别的域名等于把请求发到授权范围之外；那种情况会把
   「被重定向到 `<url>`（跨主机，未跟随）」写进证据与未命中原因，由人决定要不要纳入范围。
6. **按账本发 `Host`（vhost 探测）**：账本里 `target` 是 IP、`host` 是域名时，探针显式发
   `Host: <域名>[:端口]`（端口按目标 URL 补全；账本里 `host` 自带的端口会先剥掉再补）。
   护网里 FOFA/Hunter 给的正是「IP + 域名」组合，不发 Host 会打到默认站点——
   实测只认 vhost 的靶子上命中数为 0。**对照请求用同一个 Host**，否则一个打 vhost、
   一个打默认站点，比较毫无意义。只在 `host` 与目标主机名不同时才设，避免无谓改动。
7. **按账本的 `port` 补全探测地址**：账本里 `port` 是**独立字段**（扫描器给的是 `{host, port}`，
   `target` 常常不带端口）。探测前会把 `port` 补进 base（scheme-less 输入还会按声明的
   `protocol` 纠正 scheme）——否则会打到默认端口：实测真实 8589 的目标被探成
   `http://127.0.0.1/`（80）并**全部拒连、命中数 0**。只作用于探测，**不改账本本身**
   （账本的 `target` 参与身份键与合并，在数据层折端口会打散既有合并语义）。
8. **探针直连，不经过宿主代理**：`node:http/https` **不读** `HTTP_PROXY` 系列变量
   （宿主自己的 `fetch` 走全局 dispatcher，两边语义不同）。检测到代理变量时会**在输出里如实报出**
   （`【传输】检测到代理环境变量 …，但探针走直连`，并进 `summary.proxyEnv`）——
   避免把「代理没生效」误读成「目标不可达」。**刻意不改成走代理**：多数人设代理只为上外网，
   把探针塞进代理会让**内网目标探不通**；靠代理/隧道到达目标的人，请按需设 `NO_PROXY` 或取消代理。

这条通道只用于**探测授权目标**；模型 / 知识库等出站仍走宿主策略。

命中为 0 时，输出会多一行 **`【未命中原因】`**（去重后的前 3 条）：
miss 原因原先只活在内存里，模型看到「命中 0 项」却分不清是路径不存在、
被重定向到别处、还是响应体不含特征串。

**随机对照（软 404 防线）**：每个资产会额外发一次**随机不存在路径**的请求。
软 404 / SPA / WAF 统一响应下，「路径存在性」这类判据对任何路径都成立——
语料里 **53/63 条探针只看状态码**，没有对照的话一台这种目标能让**整库假命中**
（实测：软 404 靶子上 3/3 条目全部"命中"）。对照路径同样满足某条判据时，
**按判据类型分开处理**：

- **纯状态判据**（只看状态码）：判为**不具区分度**、不计入命中，输出
  `【对照】…这台目标的路径存在性不能当证据`；
- **内容判据**（body/header 特征）：**保留命中**，但标注
  `【统一响应】…只作产品特征，不能当路径存在的证据`——SPA 用 `try_files`
  把任意路径都兜到同一页，一律压制会把**真实部署**判成没命中
  （实测 AJ-Report SPA 上命中数会变成 0）。

对照请求数与两个计数进 `summary.controlRequests` / `controlSuppressed` / `controlUniform`，可核对。
对照本身失败（拒连/超时）时不启用对照判定——宁可按原判据跑，也不误杀真命中。

### `attack_plan`（按可复用程度生成攻击队列）

```text
workspace : 含 asset-inventory.json 的工作区
entryIds  : 可选，收窄候选条目
minAssets / maxBuckets : 可选规模参数
registerIntents : 默认 true；有 operation-state.json 时把桶登记成可追踪任务
```

对每个可筛条目做指纹匹配，按 `覆盖资产数 × 可利用性权重 ÷ 验证成本` 排序，
写 `fingerprint-buckets.json` + `attack-plan.md`。没有机器探针的命中进入 `clues`，
不混进可执行的资产组。资产组任务带 `stage=S4/S5`、`bucketId`、`targetIds`、`reuseScore`，
项目工作台的作业进度直接读取这些字段。

每个资产组同时固定一个 `representativeAssetId`：先验证代表资产，不能直接铺开整组。

### `attack_gate`（代表资产验证门）

```text
action=status  → 看每组当前是“先验证代表资产 / 可铺开同组 / 已证伪转下一组”
action=record  → 写入代表资产结果：confirmed / refuted，必须附 evidence
```

写入 `attack-progress.json`。只有 `confirmed` 才把该组标为可铺开；`refuted` 会要求转下一组。
这条状态会进入项目工作台的作业地图，避免“先撒子代理再说”的假流水线。

### `nday_learn`（现场学到的 Nday 落库）

实时检索（GitHub / 公众号 / 公开通告）找到的 Nday，**必须能沉淀下来**，否则下一轮又要重找。

```text
entry : 与 catalog.json 同构的条目 JSON
note  : 可选来源备注
```

落点：**用户层** `DSH_HOME/refs/pentest/nday/`（catalog.json + entries/<id>.md）——
**不写随包内容**，升级不丢；读取时与包层**合并**（同 id 用户层优先），
所以落库后 `nday_catalog` / `nday_match` 立刻就能用。

**同一套诚实性门禁**（放不进去比放进去更安全）：

- 声称 `normalized` / `verified` 就**必须**给出机器可判定探针；给不出来只能标 `legacy-unreviewed`。
- 没复现过的**不许**标 `verified`（要求 `verification.reproduced === true`）。
- `sources` 至少一条且必须是 http(s) URL。

### `nday_draft`（从 POC 文档生成待审核草案）

```text
documentPath : 工作区内 POC 文档（与 text 二选一）
text         : 直接给正文
entryId/product/vendor/vulnClass/sourceUrl : 可选的人工提示
```

它只做**候选抽取**：路径、错误签名、CVE/CNVD/QVD、版本、来源链接，然后生成探针骨架。
输出固定为 `legacy-unreviewed`，不会写语料，也不接受“看起来像”就自动升级为 `normalized`。
人工确认路径与判据后，再把草案 JSON 交给 `nday_learn`。

这条链路解决的是“知识包里有 76 篇泛微文档，但只有极少篇能直接机器筛选”：先自动把
文档压成几行候选，人只做最后确认，不必从头通读几十万字。

### `nday_triage`（把整个 POC 库排成待转工作单）

`nday_draft` 一次只吃一篇；本地知识包有上万篇，问题变成「**先转哪几篇**」。
这个工具扫一个目录，把每篇按**可解释的加分项**打分，排成待转工作单：

```text
root      : 要扫描的目录（知识包目录、某个厂商子目录，或工作区 docs）
workspace : root 给相对路径时按它解析
limit     : 最多列几篇（默认 20）
minScore  : 达标线（默认 30）
```

| 加分项 | 分值 | 为什么 |
|---|---:|---|
| 有官方编号（CVE/CNVD/QVD） | +40 | 好找权威来源，门禁好过 |
| 抽到 URL 级路径 | +25 | 能直接写成探针，否则只能标 `legacy-unreviewed` |
| 抽到错误签名 | +15 | 判据可从 weak 升到 medium |
| 高价值类目（未授权/RCE/上传/注入/读取/SSRF） | +15 | 能直接拿权限或读数据的优先 |
| 信创/国产观察名单 | +30 | 语料 README 写的收录优先级就是「信创与国产组件优先」 |
| 有影响版本线索 | +5 | 影响范围可判定 |
| 已进过语料 | −100 | 别每次推荐同一批已完成的 |

分数是加分项之和，**每一项都写成人话**附在工作单里，模型和人都能复核。
它只产出候选，不写语料、不改状态——落库仍要过 `nday_draft` + `nday_learn`。

三条判据是踩出来的，已钉成回归断言：

- 中文厂商名按**段首**匹配。`Apache OFBiz 身份验证绕过**导致远**程代码执行` 里的
  「导致远」正好含「致远」，一度把这份 Apache 文档顶到工作单第一名。
- ASCII 词按**词边界**匹配。`/defaultroot/upload/**infor**mation` 里的 `information`
  一度把万户 OA 判成中创。
- 厂商与类目只看**这篇文档自己的身份**（文件名 + 它自己的路径/端点），**不看引用链接**。
  `android-physical-attacks.md` 因为参考文献里出现 `weaver` 一度被加上泛微的 30 分。
- **载荷/系统侧路径不算端点**（`nday_draft` 与 `nday_triage` 共用同一条抽取器）：
  `Dubbo Hessian 反序列化` 抽出的「路径」是 `/tmp/success`（ysoserial 写文件的落点）、
  `Jackson-databind` 抽出的是 `/dev/tcp/192.168.136.129/7777`（反弹 shell 片段）——
  两条都是**库级**漏洞，本来就不该有 URL 指纹，却因此被打成满分顶到工作单前排。
  现在 `/tmp`、`/dev/tcp`、`/etc`、`/proc`、`/root`、`/home` 这类前缀，
  以及 `.yaml/.md/.txt/.conf/.sh/.jar` 这类**文档配置**后缀都会被滤掉；
  真实端点（含 `.do`、`.jsp`、`/..;/` 路径穿越写法）照常保留。

另外，文件名本身也是标题：大量 POC 把 `CVE-xxxx-xxxxx` 写在文件名上、正文不再重复，
所以编号与版本会**从文件名一并抽取**（只并编号与版本，不并路径——相对目录名混进
`paths` 会造出假探针）。

### `nday_coverage`（三层覆盖体检 + 账本驱动的覆盖缺口）

两种用法：

```text
keyword   : 查单个产品（泛微 / tongweb / 致远 …）
workspace : 读 asset-inventory.json，**派生产品关键词**并出「覆盖缺口」表
```

单关键词模式回答「这个产品本地有没有存货」；账本模式回答方案 §4.3 里那个
**「归一后的 asset-inventory.json + 覆盖缺口」**——打完一轮侦察之后，
「我这批目标里哪些产品是我三层全瞎的」。

关键词从账本的 `tech`（归一阶段抽好的技术栈，最干净）与 `title`（常含产品名）派生，
**刻意不从 URL 派生**——域名与路径会带出成百上千个噪音词。结果分三档，
**盲得最狠的排最前**：

| 档 | 含义 | 下一步 |
|---|---|---|
| 三层全空 | 语料 0 / 知识包 0 / 模板 0 | 实时检索后 `nday_learn` 落库 |
| 有文档/模板但无可筛条目 | 语料 0，其余有 | 用 `nday_draft` 转条目 |
| 已有可筛条目 | 语料 >0 | 直接 `nday_match` |

「可筛」那一档会**列出命中了哪些条目**：关键词是子串匹配，`spring` 会命中
`tongtech-tongweb-spring-httpinvoker-rce`——那其实是东方通的条目。不列出来，
看表的人会以为「Spring 已覆盖」。

### `nday_handoff`（交接单：两种模式）

```text
entryId  + asset + scope + workspace                  → 条目模式（原有）
keywords + asset + scope + workspace（不给 entryId）   → 模板直通模式
```

**模板直通**是为覆盖缺口表里「有文档/模板但没有可筛条目」那一档补的：
产品在**模板层有存货、语料层没条目**时，交接不该因为「没有 entryId」就断掉——
否则整条流水线会停在这一步（侦察到了、模板也有，却出不了计划）。

两种模式都只出计划、不执行、不投载荷；模板直通的交接单会明写
「条目：**无**（模板直通：该产品在语料层没有条目，直接走你已有的模板库）」，
不会为了好看编一个产品名。既无 `entryId` 又无 `keywords` 时直接报错。
`scope` 是必填项，未限定范围或目标越界时拒绝生成 Nuclei 命令；只有 IP/CIDR 授权时，交接目标会改写为授权 IP。

**模板选择按区分度排序**（2026-09-25 实测修正）：语料关键词里混着产品词与漏洞类词
（`sqli` / `rce` / `panel` / `cve` …），通用词能命中几百个模板。旧实现按字母序取前 40，
产品目录名（`yonyou` / `weaver` / `ruijie`）大多排在字母表后半段 → **专属模板被整个挤出**。
实测：322 条有专属模板的条目里 **61 条（19%）的交接命令一条专属模板都没带上**
（`yonyou-nc-bshservlet-rce` 有 31 条用友模板，全被 `rce` 的 165 条通用模板挤掉）。
现在先统计每个关键词的命中数，超过 40 个的算「不具区分度」，打分时专属词权重 2、通用词 1，
分高者先、同分按路径——修后 **322/322 条都能带上专属模板**。
若某个产品在本机模板库里**只有通用词命中**（没有专属模板），交接单会明写
「⚠ 全是靠通用词凑上的……别当产品指纹用」，不把通用模板冒充成产品模板。

### `zday_pattern`（0day 功能缺陷模式匹配）

```text
surface : 功能/技术面，如 “退款 并发 幂等键” / “OAuth 回调 state” / “文件上传 解析”
tech    : 可选技术栈提示
limit   : 默认 5，上限 12
```

输入功能面后，从 `preset/pentest/refs/zeroday-patterns/catalog.json` 匹配模式卡。
每条结果强制包含：

- 明确假设；
- **先想什么会推翻它**；
- 最小影响验证；
- 可组合升级的后续模式。

这不是 payload 库，也不把假设写成漏洞结论。它的价值是把 0day 阶段最难的
“我该从哪个功能本质开始想”变成可检索、可证伪的候选集合。

### `oob_probe`（带外确认原语）

```text
action="new"    → 返回 { label, domain }：把 domain 注入到要确认的载荷/参数里
action="batch"  → 给 assets（逗号/换行分隔）+ workspace：**每个资产各分一个带序号后缀的子域**
                  返回 { label, rows:[{asset, domain}] }，并把归因表落到 workspace/.saker/
action="check"  → 给 label 回查平台记录；可选 waitMs 轮询（上限 60s）。
                  batch 过的那次再带上同一个 workspace，就能**按后缀把回连归因到具体资产**，
                  输出 hitAssets 命中清单（哪个资产 ← 哪个 IP @ 什么时间）
```

**为什么批量要每资产一个子域**：共用同一个域名时，回连只能证明「这一类资产里有某个触发了」，
答不出「是**哪几台**」——而 P0-0 要的恰恰是同指纹资产里的命中清单。
所以 `batch` 用 `<label>-1` / `<label>-2` … 区分，`check` 按后缀对回归因表。
`batch` 缺 `workspace` 会直接拒绝：没有归因表就归不了因，宁可拒绝也不给一份对不上的清单。

**`nday_match` 的命中行走的是同一套**：一次筛出的所有带外命中共用**一个** label、
每个资产一个带序号后缀的子域，归因表当场落盘，命中行的 `confirm.nextCall` 直接给出
`oob_probe action=check label=<label> workspace=<workspace>`——**一次 check 就能拿到整张命中清单**。
（早先是每行各发一个独立 label，N 个命中就得 check N 次还要手工记账。）

需要 `设置 → 安全配置 → DNSLog 平台` 配齐三项：**平台地址 / token / 接收域名**（如 `abc123.ceye.io`）。
实现走 CEYE 兼容接口：`GET {url}/v1/records?token=&type=dns&filter=`，返回体取 `data[]` 或 `records[]`。

**三条不肯让步的地方**：

1. **没有 label 就拒绝**。不看 label 直接回查平台，会把别人（或历史）的记录算成你的命中——
   那是制造假阳性，比不查更糟。
2. **认不出的响应当失败**，不把平台错误页当成"有回连"。
3. **回连 ≠ 拿到权限**。回连只证明"载荷被处理并触发了外连"；要断言 RCE 还需要命令回显、
   文件落地或会话建立这类证据。输出里直接写明这一点。

未配置时明确报出缺哪一项，并提示"没有带外通道时，反序列化/盲 RCE/SSRF 只能停在疑似"。

### `access_confirm`（命中后的最小影响确认计划）

```text
entryId       : 命中条目
asset         : 待确认资产
workspace     : 工作区
bucketId      : 可选，关联 attack-plan 桶
parentTaskId  : 可选，挂到父任务图
```

按原语生成确认阶梯（RCE / 反序列化 / 文件写 / SSRF / 授权绕过 / 未知）：

- 现在允许什么（OOB、只读 whoami/id、只读身份核对等）；
- 什么动作必须用户明确批准；
- 固定禁止项（破坏性动作、持久化、把命中写成结论）；
- 证据清单、停止条件、清理步骤；
- **内存马持久化默认禁止**：未启用自建 memshell backend 时不允许部署；配置后也只进入
  “待用户明确批准”，本插件仍不执行注入。`access_confirm` 会给出基于 `memparty --api <自建地址>`
  的命令模板；真正执行必须在宿主审批放行后由用户或后续执行适配器完成。

落盘 JSON + Markdown，并可把确认步骤登记为攻击计划桶的子任务。

### `memshell_cli`（自建后端 CLI / MCP 执行适配器）

```text
action=status  → 查看 self-hosted memparty backend 是否就绪
action=plan    → transport=cli 生成精确命令；transport=mcp 生成 MCP 调用计划；只落计划，不执行
action=run     → 只按已保存的 planId 执行；需要宿主人工审批并写 note
```

命令固定为 `memparty --api <自建地址> ...`，不允许调用方覆盖 `--api` 或
`MEMPARTY_API_URL`。`gen/probe/connect/exec/upload/download` 等动作会走
`dsh-sec-enforce` 的宿主级人工审批；执行结果、退出码和输出落 `artifacts/memshell/cli-run-*.json`。
MCP 计划会把一次性令牌写入计划文件，调用 `mcp__<server>__<tool>` 时由宿主校验；
直连 memparty MCP 工具仍会触发人工审批。

**载荷/参数级审批**：审批原来只按子命令分档，`exec whoami` 与 `exec rm -rf /`
拿到的是同一句批准短语——规则写在 persona 里（删除类严禁执行），执行器却照批不误。
现在判据下沉到**参数内容**，计划里多出一个影响档 `payloadReview.impact`：

| 影响档 | 含义 |
|---|---|
| `read-only` / `read-only-exec` | 只读或诊断（`whoami`/`echo`/`ls` 一类），符合最小影响验证口径 |
| `target-probe` | 对目标发包探测，不改状态但会留痕 |
| `session` / `read` | 建立会话 / 从目标读取（可能带出数据） |
| `payload-generation` | 只生成载荷，**不投递**；投递是另一条要单独批准的动作 |
| `write` | 向目标写入：必须预先记录落地路径与清理步骤 |
| `state-changing-exec` | 命令不在只读白名单内，批准前需确认它不写入、不删除、不改配置 |
| `cleanup` | 清理动作，可能删除目标上的组件 |
| `destructive` | **直接拒绝**，连计划都建不出来 |

破坏性动作（`rm`/`del`/`format`/`shutdown`/`taskkill`/`DROP TABLE`/`DELETE FROM` 等）
在**计划阶段**就被拒绝——需要删除时正确做法是把它写成清理计划呈报用户，而不是让执行器代跑。
判据保守：参数里出现这些词就拦，宁可误拦一次也不放行一次。

## 挂载

**preset 平面**（pentest 的 `agent.cordis.yml` 一行）。宿主层行见 `cordis.patch.yml`（当前不启用）。

## 依赖

语料由根包 `dsh-saker` 提供：`preset/pentest/refs/nday/catalog.json`。
插件按 `SAKER_ROOT` → 已安装的 `dsh-saker` → 源码树 的顺序定位它；
找不到时明确报错，不静默降级成空结果。

## 测试

采集器以固定修改时间窗口分页同步 NVD 与 GitHub 公告，保存逐源游标、水位、失败退避和原始条目版本。每页持久化后再取下一页；中断保留已读内容，完整窗口结束才推进水位。CISA KEV 读取当前目录快照，移除条目保留历史并标记回源复核。OSV 采用下面的官方全库基线和变更索引；公众号与Atom模板更新仍为有限线索。后台采集默认关闭，应用退出后不会继续更新。

`cve-official` 是独立的官方CVE记录源，与NVD补充分析分开。显式选择该源后，采集器固定 `CVEProject/cvelistV5` 的提交，再按滚动 `deltaLog.json` 逐页读取原始JSON 5记录；保存CNA影响版本、CNA/ADP引用、发布时间、变更事件时间及REJECTED状态。完整记录存于本机 `nday-hunter/source-content/cve-official`，候选引用其SHA256；这些资料仍待方法审阅，不自动成为可执行PoC。断点绑定提交、窗口、查询和页大小，不受后续仓库更新影响。响应体有字节上限，损坏缓存、上游失败记录或异常链接均明确报错。

官方增量日志有保留期，首次选择的时间范围或离线间隔超过日志覆盖时会报 `cve_official_coverage_gap`。可另选 `cve-official-git` 获取当前完整记录基线和之后的文件差异，补齐保留期外的当前状态；这不会恢复上游所有中间变更事件。上游日志晚于现实时间更新时，水位只推进到已发布日志的末端。滚动源固定提交的REST接口不可用时，可通过公开Git HEAD获取确切提交；两种通道均失败仍停止。该源通过 `nday_source_collect` 选择，不属于 `nday_source_fetch` 的有限线索接口，也未加入默认来源列表。专项：`node scripts/test-cve-official.mjs`。

### 固定提交的项目文件来源

桌面来源设置及 `nday_source_collect` 可显式选择以下Git来源，需要本机Git，默认均未启用：

| 来源 | 实际范围 |
|---|---|
| `github-research-files` | 登记的 [Threekiii/Awesome-POC](https://github.com/Threekiii/Awesome-POC) 公开研究材料及代码 |
| `nuclei-files` | [projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates) 的YAML模板正文 |
| `afrog-files` | [zan8in/afrog](https://github.com/zan8in/afrog) 的公开 `pocs/afrog-pocs` 目录，不包含加密精选库 |
| `cve-official-git` | [CVEProject/cvelistV5](https://github.com/CVEProject/cvelistV5) 当前完整CVE JSON文件树 |

首次读取当前文件基线；以后比较上一完整提交与新固定提交，分别记录新增、正文修改、删除及同内容移动。没有只取README或最新若干提交，也不把提交日期或目录年份当作披露日期。删除和移走的旧路径保留历史、标记回源复核。汇编作者不等于原始研究作者，模板也不等于已验证漏洞；资料仅待审阅，未自动执行来源代码。

本机仅保存bare Git对象，无工作树检出；关闭钩子、凭据交互和外部协议。正文按页通过一个Git批次读取，校验对象身份、长度和内容摘要。超大、链接、子模块或无法索引的编码明确保留缺口；当前不读取这些内容为检测方法。不可变页缓存绑定来源、查询、页大小、窗口与前后提交；中断不推进完整提交，所有分页处理完才切换来源版本。`contentGaps` 表示正文索引缺口，完整文件清单不代表全部方法已经就绪。代码和原始资料以内容摘要保存在本机源缓存，插件/方法包版本各自独立。

专项：`node scripts/test-source-git.mjs`、`node scripts/test-repository-sources.mjs`。当前实现仍需评估超大CVE基线的全量记录索引成本；小库的完成证据不能替代全量CVE验收。

历史候选不再按500条截断或被下一轮失败覆盖；源状态损坏时停止同步并保留原文件。当前记录、历史修订及断点以SQLite为准；旧版JSON与JSONL在首次读取时迁移。撤回、拒绝及目录移除保留来源状态，需复核后再使用。专项：`node scripts/test-source-incremental.mjs`（从仓库根运行）。

```bash
node --import ../../scripts/test-stub-register.mjs test/run.mjs
```

覆盖：目标解析、单探针判定（含"没有 expectation 不算命中"）、屏幕结论分级、
URL 拼接、真实语料的读取与过滤、两个工具的注册与执行，
以及用**本地 fixture 服务器**跑通的端到端批量筛选（含台账落盘与规模上限拒绝）。

### 本地资料索引与按需原文

来源记录、修订历史和每页断点存入 `nday-hunter/source-index.sqlite`，以一个事务提交；`collector-state.json` 仅保留小型统计镜像。数据库提交后镜像写入中断时，下次读取以数据库为准。首次迁移旧JSON时先保存原字节的SHA256命名备份，保留全部来源记录与旧修订历史；历史尾部未提交内容不会自动替换当前记录。数据库或旧文件损坏会明确失败，不能伪装为空库。

状态响应默认不附带候选正文。`nday_source_radar` 的 `query` 检索本地编号、标题、摘要、产品与来源元数据，返回最多20条摘要及 `nextCursor`；传入原查询和 `cursor` 续页。库版本或检索条件变化后旧游标失效，需要重新搜索。三字符以上使用FTS5 trigram索引，短词仍按字面匹配；这是元数据检索，不宣称搜索了所有原文件的全部影响版本/正文。

需要原文时传 `record: "来源ID:记录ID"`，例如 `cve-official-git:CVE-2024-20481`。原文返回不超过12000字符及 `nextOffset`；继续传 `offset` 和首次返回的 `revision`，固定原修订。读取前校验缓存路径边界和完整SHA256。官方CVE正文上限8MiB，普通项目/模板仍为2MiB。候选依旧需要审阅，不自动执行原文代码。

桌面设置「漏洞情报更新」中的「本地资料检索」默认折叠；主动检索、翻页和查看来源原文后才读取资料。检索不触发联网采集或目标请求。数据库不随插件升级覆盖，完整原始材料仍保存于来源内容缓存。

### OSV官方导出与可恢复更新

首次选择OSV从官方跨生态`all.zip`建立基线，包含撤回记录。下载量较大，按固定GCS generation分块读取，核对范围、长度和整包MD5后保留SHA256；下载和记录页都有断点。压缩包不解压为大量小文件，ZIP/ZIP64字节索引支持按固定修订读取完整JSON原文，并校验包摘要、记录CRC与全文SHA256。OSV单条原文上限32MiB；其它公告仍为8MiB，超限或损坏明确失败，不静默截断。

基线结束后保留初始水位并安排后续更新。增量固定官方`modified_id.csv`版本，按声明的修改时间窗口选择记录；同一编号在多个生态目录出现时只读取一次完整当前API记录。水位只推进到已发布导出的时间，下一轮重叠一天。当前API记录可能比索引新，不声称导出与API属于同一全局事务；上游删除的记录可能被撤回或保留为孤立记录，遵循OSV官方语义，不将索引缺席自动解释为已修复。

每页记录与游标仍在SQLite事务中提交，失败页保留原水位和旧修订。已完成包的下载凭据支持数据库页提交失败后的复用，未提交的尾部下载字节在重试时丢弃。设置页显示下载进度，聊天页不增加状态说明。专项：`node scripts/test-osv-export.mjs`。完整真实全库的终结证据记录于实施审计，不能用小型夹具替代全库验收。

### 固定来源修订的条件判断

传入`record`、`revision`及`environment`可以判断完整公告的适用条件。结果始终是所提供清单下的条件判断，`findingConfirmed=false`；不会执行检测或证明漏洞已复现。未知身份、版本、比较规则和清单缺口保留unknown。

OSV使用`packages:[{name,ecosystem,version,evidenceIds}]`。明确SEMVER范围和精确版本清单可判断；未实现生态原生版本规则和Git提交图时不套用SemVer。

NVD使用`assetId`、`assetEvidenceIds`绑定单个资产。`cpes:[{cpe,evidenceIds,versionScheme?,versionSchemeEvidenceIds?}]`保留配置AND/OR、否定及环境条件。版本范围需要明确比较依据，不能由版本外观猜测。独立的新版`affectedData`使用`products:[{vendor,product,version,evidenceIds}]`，或声明的`packageURL`、`collectionURL+packageName`身份；名称按来源原值核对，不将CPE简称猜成厂商全名。支持精确版本、明确semver区间、默认状态及排序后的changes；custom、发行版和其它比较器仍需补齐。限定平台、模块、文件或函数时，在对应产品观察中提供`platforms`、`modules`、`programFiles`、`programRoutines`名称数组与同名`EvidenceIds`。原生产品中的CPE链接还不能用作已验证的身份桥接。

排除未观察到的对象需要相应完整清单依据：OSV为`inventoryComplete+inventoryEvidenceIds`，NVD的CPE与产品分别为`cpeInventoryComplete+cpeInventoryEvidenceIds`、`productInventoryComplete+productInventoryEvidenceIds`。完整CPE清单不自动证明原生产品清单完整。限定上下文缺失也不能默认排除；完整上下文需要同名`InventoryComplete`和`InventoryEvidenceIds`。两种NVD表示都存在时分别计算，未知或不一致保留unknown，产品命中不能越过CPE配置要求；同一产品的来源状态冲突也保持unknown。
