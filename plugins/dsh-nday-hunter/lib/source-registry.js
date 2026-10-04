// Source capability registry for Nday discovery.
//
// This file is intentionally boring: it prevents the UI/model from calling a
// source "integrated" just because its name appears in a playbook. Each row
// states whether Saker can actually fetch it, how it authenticates, and where
// the credential is configured.

export const SOURCE_INTEGRATIONS = Object.freeze({
  API: 'api',
  GIT: 'git',
  SCRIPT: 'script',
  HOST_SEARCH: 'host-search',
  GUIDANCE: 'guidance',
})

export const NDAY_SOURCE_REGISTRY = Object.freeze([
  {
    id: 'fofa',
    label: 'FOFA',
    category: 'asset-search',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'api-key',
    implemented: true,
    configuredVia: '设置 → 资产平台 API',
    detail: 'asset_search / asset_search_batch / nday_scope_hunt 可直接调用；密钥存本机 hunter.db。',
  },
  {
    id: 'hunter-asset',
    label: '奇安信 Hunter（资产测绘）',
    category: 'asset-search',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'api-key',
    implemented: true,
    configuredVia: '设置 → 资产平台 API',
    detail: 'Hunter OpenAPI 资产搜索；这是资产测绘 API，不是奇安信 CERT 情报接口。',
  },
  {
    id: 'quake-asset',
    label: '360 Quake（资产测绘）',
    category: 'asset-search',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'api-key',
    implemented: true,
    configuredVia: '设置 → 资产平台 API',
    detail: 'Quake API 资产搜索；密钥存本机 hunter.db。',
  },
  {
    id: 'avd-aliyun',
    label: '阿里云漏洞库 AVD',
    category: 'advisory',
    integration: SOURCE_INTEGRATIONS.SCRIPT,
    auth: 'none',
    implemented: 'external-script',
    configuredVia: '无需 key；_ref/tools/avd-fetch.mjs 经 Chrome for Testing 渲染',
    detail: '可补 CNVD/AVD 编号、披露信息和厂商公告链接；不是插件内自动抓取器。',
  },
  {
    id: 'cve-official',
    label: 'CVE官方记录',
    category: 'advisory',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'public-feed',
    implemented: true,
    configuredVia: '增量采集选择cve-official；无需key',
    detail: '固定CVEProject/cvelistV5提交的滚动deltaLog，分页读取原始CVE JSON 5的CNA和ADP引用、影响条件及撤回状态；缺失历史窗口明确报缺口，不冒充全量同步。',
  },
  ...[
    ['cve-official-git', 'CVE官方全量基线/Git差异', 'CVEProject/cvelistV5当前文件树；分页完成才切换提交。可补滚动日志之外的离线间隔，不能证明每次中间修改事件均被保留。'],
    ['github-research-files', 'GitHub研究项目文件', '登记Threekiii/Awesome-POC公开汇编，逐文件保存原始材料、内容摘要、提交及增删改移动；原始作者和适用条件待审阅。'],
    ['nuclei-files', 'Nuclei模板文件差异', 'projectdiscovery/nuclei-templates固定提交的YAML文件正文与差异；模板仅待审阅，不自动执行。'],
    ['afrog-files', 'Afrog公开PoC文件差异', 'zan8in/afrog公开pocs/afrog-pocs目录；不包含加密精选库，内容仅待审阅。'],
  ].map(([id, label, detail]) => ({ id, label, category: id === 'cve-official-git' ? 'advisory' : 'research-project',
    integration: SOURCE_INTEGRATIONS.GIT, auth: 'public-git', implemented: true,
    configuredVia: '桌面来源设置或nday_source_collect；需要Git，默认未启用', detail })),
  {
    id: 'nvd',
    label: 'NVD补充分析',
    category: 'advisory',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'public-api',
    implemented: true,
    configuredVia: '内置免费适配器，无需 key',
    detail: 'NVD REST API 2.0；匿名请求有速率限制，适配器按候选记录返回。',
  },
  {
    id: 'osv',
    label: 'OSV',
    category: 'advisory',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'public-api',
    implemented: true,
    configuredVia: '内置免费适配器，无需 key',
    detail: '官方跨生态ZIP全量基线、固定版本modified_id.csv增量及完整JSON记录；压缩包原文按需读取。覆盖开源依赖，不覆盖大多数封闭式信创产品。',
  },
  {
    id: 'github-advisories',
    label: 'GitHub Security Advisories',
    category: 'advisory',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'optional-token',
    implemented: true,
    configuredVia: '内置免费适配器；可选 GitHub token（当前不要求）',
    detail: 'GitHub Global Security Advisories API；匿名低配额调用，稳定高频可另配 token。',
  },
  {
    id: 'nuclei',
    label: 'nuclei-templates 更新',
    category: 'exploit-signal',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'public-feed',
    implemented: true,
    configuredVia: '内置免费适配器，无需 key',
    detail: '读取 projectdiscovery/nuclei-templates 的公开 commit Atom feed，记录模板变更时间、提交链接和模板路径；模板更新只是 PoC 线索，不代表漏洞已确认。',
  },
  {
    id: 'cisa-kev',
    label: 'CISA KEV',
    category: 'exploit-signal',
    integration: SOURCE_INTEGRATIONS.API,
    auth: 'public-feed',
    implemented: true,
    configuredVia: '内置免费适配器，无需 key',
    detail: '公开 JSON 清单，适合判断在野利用，不是最新披露全量源。',
  },
  {
    id: 'cnvd',
    label: 'CNVD',
    category: 'advisory',
    integration: SOURCE_INTEGRATIONS.HOST_SEARCH,
    auth: 'captcha/manual',
    implemented: false,
    configuredVia: '未接入；由 web_search / web_fetch 与人工打开页面',
    detail: '页面有验证码，不能把匿名抓取失败算作零结果。',
  },
  {
    id: 'cnnvd',
    label: 'CNNVD',
    category: 'advisory',
    integration: SOURCE_INTEGRATIONS.HOST_SEARCH,
    auth: 'account/limited',
    implemented: false,
    configuredVia: '未接入；由 web_search / web_fetch 与人工打开页面',
    detail: '部分数据下载需要账号权限，先确认许可再自动化。',
  },
  {
    id: 'qianxin-cert',
    label: '奇安信 CERT / 威胁情报通告',
    category: 'domestic-intel',
    integration: SOURCE_INTEGRATIONS.GUIDANCE,
    auth: 'unknown',
    implemented: false,
    configuredVia: '未接入 API，也没有自动抓取脚本',
    detail: '当前只是来源名和检索指引；目录中引用过 ti.qianxin.com 的公告链接，不代表已经接入接口。',
  },
  {
    id: 'wechat',
    label: '微信公众号 / 安全社区',
    category: 'domestic-intel',
    integration: SOURCE_INTEGRATIONS.SCRIPT,
    auth: 'search-engine/manual',
    implemented: true,
    configuredVia: '内置 search-assisted 适配器：搜狗微信搜索',
    detail: '无官方开放搜索 API；适配器读取公开搜索结果并保留公众号/日期/链接，必须回到公告、编号或 GitHub 交叉验证。',
  },
])

export function sourceRegistrySummary(rows = NDAY_SOURCE_REGISTRY) {
  const summary = { implemented: 0, git: 0, script: 0, hostSearch: 0, guidance: 0, plannedApi: 0 }
  for (const row of rows) {
    if (row.implemented === true && row.integration === SOURCE_INTEGRATIONS.API) summary.implemented += 1
    else if (row.implemented === true && row.integration === SOURCE_INTEGRATIONS.GIT) summary.git += 1
    else if (row.implemented === true && row.integration === SOURCE_INTEGRATIONS.SCRIPT) summary.script += 1
    else if (row.implemented === 'external-script') summary.script += 1
    else if (row.integration === SOURCE_INTEGRATIONS.HOST_SEARCH) summary.hostSearch += 1
    else if (row.integration === SOURCE_INTEGRATIONS.GUIDANCE) summary.guidance += 1
    else summary.plannedApi += 1
  }
  return summary
}
