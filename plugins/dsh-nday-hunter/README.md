# dsh-nday-hunter

把 Nday 语料变成动作：**批量指纹筛选 + 诚实的短名单 + 带外确认原语 + 交接单**。

## 解决的问题

2026-09 护网复盘里，冠军队伍用**信创的东方通一个 Nday** 拿下 8 个 shell；
我们当时既没有那类组件的知识（`refs/` 对信创零覆盖），**也没有把知识变成批量动作的能力**。
`refs/nday/` 补了前半截，本插件补后半截：

| 缺口 | 本插件怎么补 |
|---|---|
| 知道有漏洞，但不知道**哪些资产**符合指纹 | `nday_match` 拿一批资产 × 语料里**机器可判定**的探针，批量跑出短名单 |
| 现场目标很多，人工逐产品拼 FOFA 查询太慢 | `nday_scope_hunt` 按 RCE 优先组合目录显式指纹、GET/HEAD 响应签名、目录端口收窄和产品别名兜底，在授权范围内调用 FOFA，并保留“查询 → 条目 → 候选资产”映射 |
| 跑完一堆"疑似"没法判断可信度 | 每条命中带**证据强度**（weak/medium/strong）与逐探针理由；结论只到 `fingerprint-*` |
| 不知道下一步怎么确认 | 命中行直接给出条目 `exploit.tools` 里点名的**公开工具**，作为交接单 |
| 反序列化/盲 RCE/SSRF 这类面**只能用带外回连确认** | `oob_probe` 提供 DNSLog 带外通道：分配唯一子域 → 注入 → 回查，回连归因到本次测试 |
| 结果散落在聊天里 | 台账落 `artifacts/nday/*.json|.csv`，并回写 `evidence-index.md` 一行 |

## 工具

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
```

当前语料快照（更新于 2026-09-25）中，默认 RCE 计划筛出 69 条条目，生成 79 组去重查询：13 组来自目录显式指纹，17 组来自 GET/HEAD 探针响应签名，2 组由产品与目录端口收窄，47 组为产品别名兜底。默认首批 20 组只包含前 3 类高信号查询；其余组通过 `nextOffset` 分页。每次搜索与证据文件都会列出查询依据和目录覆盖质量。FOFA 请求串行限速，结果显示 API 请求数和预计耗时；API 字段权限不足、认证失败和其他查询错误单独记录，不会伪装成零候选。

FOFA 搜索是被动索引查询，不向目标发送请求。资产会在查询范围约束后再做本地范围过滤，产物只保留范围内候选。每个候选映射到对应的 Nday 条目和查询依据。测绘命中只代表产品/页面指纹候选，**不代表受影响版本、漏洞或 RCE**。

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

```bash
node --import ../../scripts/test-stub-register.mjs test/run.mjs
```

覆盖：目标解析、单探针判定（含"没有 expectation 不算命中"）、屏幕结论分级、
URL 拼接、真实语料的读取与过滤、两个工具的注册与执行，
以及用**本地 fixture 服务器**跑通的端到端批量筛选（含台账落盘与规模上限拒绝）。
