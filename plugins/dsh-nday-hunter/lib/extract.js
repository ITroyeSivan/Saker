// dsh-nday-hunter / extract.js —— 从一篇 POC 文档里抽出「能变成探针的东西」。
//
// 为什么需要：本地知识包里有大量文档（实测泛微 76 篇、致远 44 篇），但**只有极少数
// 能被机器判定**。要把它们变成可批量筛的语料，得先有人把「路径 + 判据」提炼出来——
// 这一步天然是判断，不可能全自动。但**抽取候选**可以自动：把文档里像路径、
// 像错误签名、像版本区间、像编号的东西先摘出来摆到人面前，人只做确认，不做通读。
//
// 纯函数，无 IO：输入文本，输出候选。**它只提候选，不下结论**——
// 落库仍然要过 nday_learn 的诚实性门禁。

/** 看起来像 URL 路径的片段（至少两段，允许 `;` 与 `..` 这类绕 WAF 写法）。 */
const PATH_RE = /(?:^|[\s"'`(（])((?:\/[A-Za-z0-9_.~%\-;]+){2,})/g
/**
 * 单段但带已知接口后缀的路径。
 * 踩过的坑：`/Kingdee.BOS.ServiceFacade.ServicesStub.DevReportService.GetBusinessObjectData.common.kdsvc`
 * 只有一段（没有第二根斜杠），上面那个"至少两段"的规则会整条漏掉——而金蝶这条恰好是未授权 RCE。
 */
const SINGLE_SEGMENT_PATH_RE = /(?:^|[\s"'`(（])(\/[A-Za-z0-9_.\-]+\.(?:kdsvc|do|action|jsp|jspx|php|aspx|ashx|ash|servlet|war|cgi))\b/g
/** 裸文件名/入口名（没有前导斜杠，常见于文章标题与表格）。 */
const ENDPOINT_RE = /\b([A-Za-z0-9_\-]{3,}\.(?:jsp|jspx|do|action|php|aspx|ashx|ash|kdsvc|servlet|war|cgi|json))\b/gi
/** 类名式的服务入口（如 Kingdee.BOS.ServiceFacade... 这类以点分命名空间的路径尾段）。 */
const NAMESPACED_RE = /\b([A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*){2,})\b/g
/** 能当判据的异常/错误签名。 */
const SIGNATURE_RE = /\b(?:java|javax|jakarta|org)\.[A-Za-z0-9_.$]*(?:Exception|Error)\b|\b(?:NullPointerException|Whitelabel Error Page|Stacktrace|stack trace|Application Error)\b/g
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi
const CNVD_RE = /\bCNVD-(?:C-)?\d{4}-\d{4,7}\b/gi
const QVD_RE = /\bQVD-\d{4}-\d{4,7}\b/gi
const VERSION_RE = /\b\d+\.\d+(?:\.\d+){0,3}(?:\.\d{6,8})?\b/g
const LINK_RE = /https?:\/\/[^\s<>"'`)\]]+/g

const uniq = (list) => [...new Set(list)]

// 明显是**载荷/系统侧**的路径，不是产品端点。
//
// 踩过的坑（2026-09-25，工作单把两条库级漏洞顶到前排才发现）：
// `Apache Dubbo Hessian 反序列化` 的文档抽出的「路径」是 `/tmp/success`——
// 那是 ysoserial 写文件的落点；`Jackson-databind` 抽出的是
// `/dev/tcp/192.168.136.129/7777`——那是反弹 shell 的命令片段。
// 两条都是**库级**漏洞（触发在反序列化，不在 HTTP 端点上），本来就不该有 URL 指纹，
// 却因为这两条「路径」被打了满分。文档/配置类后缀同理：`docker-compose.yaml`
// 是搭建说明里的文件名，不是接口。
const PAYLOAD_PATH_PREFIXES = [
  '/dev/tcp/', '/dev/udp/', '/dev/shm/', '/tmp/', '/var/tmp/', '/private/tmp/',
  '/etc/', '/proc/', '/sys/', '/root/', '/home/', '/var/log/',
]
const NON_ENDPOINT_EXT_RE = /\.(?:ya?ml|md|txt|conf|cfg|ini|log|sh|bash|ps1|bat|cmd|jar|class)$/i

function looksLikePayloadPath(value) {
  const lower = value.toLowerCase()
  if (PAYLOAD_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  return NON_ENDPOINT_EXT_RE.test(lower)
}

/**
 * 从一段文本里抽候选。
 * @param {string} text - 文档正文
 * @returns {{ paths: string[], endpoints: string[], namespaces: string[], signatures: string[], ids: object, versions: string[], links: string[] }}
 */
export function extractNdayCandidates(text) {
  const source = String(text || '')
  const paths = []
  for (const match of [...source.matchAll(PATH_RE), ...source.matchAll(SINGLE_SEGMENT_PATH_RE)]) {
    const value = match[1].replace(/[.,;:]+$/, '')
    // 过滤明显不是接口的：纯静态资源、只剩斜杠
    // 单段路径只有在带已知接口后缀时才保留（否则多半是文章里的普通斜杠片段）
    if (value.split('/').filter(Boolean).length < 2
      && !/\.(?:kdsvc|do|action|jsp|jspx|php|aspx|ashx|ash|servlet|war|cgi)$/i.test(value)) continue
    if (/\.(?:css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf)(?:$|\?)/i.test(value)) continue
    if (looksLikePayloadPath(value)) continue
    paths.push(value)
  }
  const endpoints = [...source.matchAll(ENDPOINT_RE)].map((m) => m[1])
  const namespaces = [...source.matchAll(NAMESPACED_RE)].map((m) => m[1]).filter((v) => v.includes('.') && v.length >= 8)
  const signatures = uniq([...source.matchAll(SIGNATURE_RE)].map((m) => m[0]))
  const ids = {
    cve: uniq([...source.matchAll(CVE_RE)].map((m) => m[0].toUpperCase())),
    cnvd: uniq([...source.matchAll(CNVD_RE)].map((m) => m[0].toUpperCase())),
    qvd: uniq([...source.matchAll(QVD_RE)].map((m) => m[0].toUpperCase())),
  }
  const versions = uniq([...source.matchAll(VERSION_RE)].map((m) => m[0])).filter((v) => v.length <= 20)
  const links = uniq([...source.matchAll(LINK_RE)].map((m) => m[0].replace(/[.,;:]+$/, '')))
  return {
    paths: uniq(paths).sort((a, b) => b.length - a.length),
    endpoints: uniq(endpoints),
    namespaces: uniq(namespaces),
    signatures,
    ids,
    versions: versions.slice(0, 40),
    links: links.slice(0, 20),
  }
}

/**
 * 把候选整理成**待人工确认**的探针草案：给出建议路径与建议判据，但不替你拍板。
 * 判据优先级：错误签名 > 状态码排除。签名为空时只给弱探针，并在 note 里写明。
 * @returns {{ probes: object[], needsHuman: string[] }}
 */
export function draftProbes(candidates, { maxPaths = 3 } = {}) {
  const probes = []
  const needsHuman = []
  const paths = (candidates.paths || []).slice(0, maxPaths)
  if (paths.length === 0) needsHuman.push('文档里没抽到可用路径——需要人工补一条 URL 级指纹，否则只能标 legacy-unreviewed')
  const signature = (candidates.signatures || [])[0]
  if (!signature) needsHuman.push('文档里没抽到错误签名——判据只能先用「状态码非 404」这类弱信号，命中强度记为 weak')
  for (const [index, value] of paths.entries()) {
    probes.push({
      id: `p${index + 1}-presence`,
      path: value,
      method: 'GET',
      expect: signature ? { bodyContainsAny: [signature] } : { statusNotIn: [404] },
      weight: signature ? 'medium' : 'weak',
      note: signature
        ? `判据取自文档里出现的错误签名 ${signature}；**仍需人工确认它确实只在该漏洞分支上出现**。`
        : '只有路径存在性——反代与统一错误页同样非 404，人工必须确认后再落库。',
    })
  }
  return { probes, needsHuman }
}
