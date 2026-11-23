import { normalizeDefinition } from './schema.js'

const node = (id, title, instruction, tools, output, completion = 'artifact') =>
  ({ id, title, instruction, tools, output, completion })

export const DEFAULT_WORKFLOWS = Object.freeze([
  normalizeDefinition({
    id: 'web-default',
    version: '1',
    title: '测网站与接口',
    description: '从目标和已有材料出发，先建立入口与身份，再用具体假设驱动请求和对照。',
    mode: 'pentest',
    nodes: [
      node('target', '收集目标与入口', '规范用户给出的网址、域名、材料、账号和授权范围。先使用已有材料或清单；单网址不强制做企业测绘。保留原始 URL、Host、端口、来源和范围判定。', ['saker_material', 'httpx_probe', 'saker_browser'], '目标与入口清单，标明哪些在范围内、哪些不能访问。'),
      node('inspect', '了解网站与账号', '用已有响应、浏览器或必要的存活/指纹工具了解入口、接口和对象关系。已有材料不重抓；不要因为一个图标就确认产品版本。', ['saker_browser', 'redteam_execution', 'saker_material'], '接口/对象/身份关系与不确定项。'),
      node('hypothesis', '选择检查项', '结合实际功能、参数、对象和已得组件证据，提出可验证的具体问题，按价值、可达性和成本排序。不是把所有扫描器跑一遍。', ['redteam_research', 'tool_pack'], '一个当前要验证的具体问题及需要的对照。'),
      node('verify', '验证并保留请求', '使用当前可用请求工具或浏览器发送真实请求，保留正常对照、身份和目标引用。命中或异常不自动等于漏洞。', ['redteam_execution', 'saker_browser', 'oob_probe'], '请求/响应/回执与正常对照。', 'receipt'),
      node('evidence', '整理发现', '复查原始证据，合并真重复，区分确认、待复核、误报、未测和受阻。没有有效发现也如实结束。', ['project_evidence', 'redteam_finding_register', 'saker_material'], '可复现的证据、结论和未覆盖项。'),
    ],
  }),
  normalizeDefinition({
    id: 'nday-default',
    version: '1',
    title: '查组件已知漏洞',
    description: '把用户声明的软件和版本转到公告条件，再逐目标验证适用性。',
    mode: 'pentest',
    nodes: [
      node('identify', '识别或采用已知软件', '用户已给出软件名称时直接采用声明；只有未知时才补必要指纹。用 saker_component observe 记录产品、别名、版本和来源；版本未知不猜。', ['saker_component', 'httpx_probe', 'saker_material'], '产品/版本/证据或明确的未知项。'),
      node('bulletin', '查公告与验证前提', '从允许的可信公告或本地材料建立候选公告，用 saker_component advisory 保存来源、版本范围和必要条件；无匹配公告不等于安全。', ['saker_component', 'redteam_research', 'tool_pack'], '候选公告及逐目标适用条件。'),
      node('verify', '逐个目标验证', '选择符合条件的方法和工具，检查实际前提，发送真实请求并保留正常对照和身份绑定；用 saker_component evaluate 记录适用、不适用或不能判断。', ['saker_component', 'redteam_execution', 'oob_probe'], '适用/不适用/不能判断及实际验证回执。', 'receipt'),
      node('summarize', '汇总', '分别报告已验证、未复现、不适用和缺条件，附来源与实际证据。', ['project_evidence'], '分层结论和未覆盖项。'),
    ],
  }),
  normalizeDefinition({
    id: 'code-default',
    version: '1',
    title: '研究组件安全更新',
    description: '从目标组件追溯到可信修复，再回到目标验证实际影响。',
    mode: 'code-audit',
    nodes: [
      node('component', '找到目标使用的软件', '从目标或材料识别组件，再核对官方项目、包和部署版本。用 saker_component observe 记录来源，再用 action=upstream 自动查公开上游候选；仓库同名或搜索排名不能直接算可信映射。', ['saker_component', 'saker_material', 'semgrep_scan'], '可信组件、版本、上游候选或明确缺口。'),
      node('diff', '阅读相关修复', '围绕目标版本、发行线和功能缩小提交窗口，用 action=research_upstream 读取有限 compare 与调用上下文，关联实际入口、配置和身份；用 saker_component advisory 保存有来源的版本范围与前提。', ['saker_component', 'redteam_research', 'pwsh'], '相关修复、调用位置和可达性判断。'),
      node('reproduce', '复现与相似代码', '在受管环境准备漏洞版/修复版和正常对照；成立后有界检查相关入口，不无限扩变体。', ['semgrep_scan', 'redteam_research'], '本地复现或构建失败原因。'),
      node('target', '回到目标核对', '分别核对部署、功能和入口，用允许的方式验证；本地复现与目标影响分开记录，并用 saker_component evaluate 记录逐目标适用性。', ['saker_component', 'redteam_execution', 'project_evidence'], '目标影响结论与证据。', 'receipt'),
    ],
  }),
  normalizeDefinition({
    id: 'code-review',
    version: '1',
    title: '审查一段代码',
    description: '从代码入口和信任边界出发，追踪缺失校验，形成可复现结论或明确反证。',
    mode: 'code-audit',
    nodes: [
      node('map', '读取代码与入口', '先确认语言、框架、路由/入口和身份来源，再列出信任边界与用户可控输入；不要一开始就报整文件。', ['saker_material', 'pwsh'], '入口、信任边界和可控输入清单。'),
      node('trace', '追踪数据流与权限', '沿具体参数追到危险操作（查询、文件、命令、导出、鉴权分支），记录缺失的校验和可达前提。', ['semgrep_scan', 'pwsh', 'saker_material'], '可疑数据流、缺失校验和可达条件。'),
      node('prove', '构造可复现验证', '用最小复现或等价静态对照证明问题成立；无法运行时明确写清缺什么条件，不能把“看起来像”当已确认。', ['redteam_execution', 'project_evidence', 'pwsh'], '可复现步骤或明确的不可验证原因。'),
      node('record', '记录发现与反证', '把已确认问题写入 finding，附文件/行号与依据；被证伪的假设也要保留反证，避免下一轮重复。', ['redteam_finding_register', 'project_evidence'], 'finding 或反证记录。'),
    ],
  }),
  normalizeDefinition({
    id: 'ctf-single',
    version: '1',
    title: '解一道比赛题',
    description: '先读题和附件，再从题型选择可观察的方法，最后独立验证 flag。',
    mode: 'ctf-solver',
    nodes: [
      node('read', '读题与附件', '读取题面、附件、实例地址、限制和已给提示。区分已知事实、需要验证的假设和缺失条件。', ['competition_challenge', 'saker_material'], '题目条件、附件和未知项。'),
      node('route', '判断题型与入口', '按 Web/Pwn/Reverse/Crypto/Misc/Forensics 等实际材料选择可观察方法，不按题名猜答案。', ['tool_pack', 'saker_material'], '题型、入口和第一步验证方法。'),
      node('solve', '执行并保留证据', '执行脚本、分析文件或访问实例，保留实际输出和中间结果。受阻时说明具体依赖，不伪造 flag。', ['competition_execution', 'saker_browser', 'redteam_research'], '可复查的解题过程与候选 flag。'),
      node('verify', '独立验证 flag', '用题目自己的验证方式或实例行为确认 flag；占位、假 flag 和平台拒绝不能算解出。', ['competition_answer', 'competition_execution'], '已验证 flag 或明确的未解卡点。'),
    ],
  }),
  normalizeDefinition({
    id: 'ctf-multi',
    version: '1',
    title: '统筹多道比赛题',
    description: '多题共享时间和并发，但按题隔离材料、实例和结论。',
    mode: 'ctf-solver',
    nodes: [
      node('inventory', '盘点题单与分值', '整理题名、模块、分值、截止时间、附件和实例状态。缺条件的题单独标出，不阻塞其他题。', ['competition_challenge', 'saker_material'], '题单、优先级和缺条件项。'),
      node('schedule', '分配时间与并发', '按价值、可达性和剩余时间排序；共享根预算与并发，不按每题各自重置。', ['tool_pack', 'todo_write'], '当前要做的题和资源分配。'),
      node('solve', '逐题求解并隔离证据', '每道题单独保存题面理解、实例、命令和候选答案；不把一个题的凭据或 flag 带到另一个题。', ['competition_execution', 'saker_browser', 'redteam_research'], '逐题证据与状态。'),
      node('track', '更新比赛台账', '把已解、卡点、放弃和待验证分开更新；临近截止或超时不得盲重发。', ['competition_challenge', 'competition_answer'], '实时台账和下一步。'),
      node('report', '收口与复盘', '汇总已验证 flag、未解题和缺条件原因，保留原附件与实例修订。', ['competition_answer', 'project_evidence'], '可追溯的比赛结果。'),
    ],
  }),
  normalizeDefinition({
    id: 'requirements-verify',
    version: '1',
    title: '按要求验证',
    description: '按导入要求逐项检查，独立项继续，缺条件项明确退出。',
    mode: 'pentest',
    nodes: [
      node('requirements', '读取测试要求', '按原文提取检查项、顺序、账号、环境和每项的完成条件；不把一句总结当完整要求。', ['saker_material', 'project_document'], '可执行检查清单。'),
      node('map', '建立检查映射', '把每项要求绑定到目标、身份、接口、材料或需要补齐的条件；不明项保留原文。', ['project_check', 'tool_pack'], '要求×目标×证据映射。'),
      node('execute', '逐项执行', '执行独立项并保存真实请求、截图、命令或文件回执；缺条件项记原因，其他项继续。', ['redteam_execution', 'saker_browser', 'project_evidence'], '逐项结果与证据。', 'receipt'),
      node('report', '按原要求汇总', '按原顺序报告通过、失败、受阻和未执行；不把未测写成通过，不合并掉单题证据。', ['project_evidence', 'project_check'], '逐项结论和未完成项。'),
    ],
  }),
  normalizeDefinition({
    id: 'retest',
    version: '1',
    title: '复测历史问题',
    description: '绑定原问题版本，重新核对影响并明确本次是否复现。',
    mode: 'pentest',
    nodes: [
      node('reopen', '读取原问题与证据', '读取原发现、复现步骤、身份、目标版本和上次证据；确认哪些前提已经变化。', ['redteam_task', 'project_evidence', 'saker_material'], '原证据版本和复测前提。'),
      node('reproduce', '重新验证', '在当前条件下重新发出必要请求或执行步骤，保留新回执；不复用旧回执冒充本次结果。', ['redteam_execution', 'saker_browser'], '本次复现回执。', 'receipt'),
      node('control', '正常功能对照', '同时保留不含载荷的正常功能请求，证明差异来自问题而不是服务不可用。', ['redteam_execution', 'project_request'], '同源同身份的正常对照。', 'receipt'),
      node('record', '记录本次结论', '把仍可复现、本次未复现或无法确认写进新版本，引用本次回执，不改写旧结论。', ['redteam_finding_update', 'project_evidence'], '带证据的新复测版本。'),
    ],
  }),
])

export function workflowById(id) {
  return DEFAULT_WORKFLOWS.find(item => item.id === id) || null
}

export function defaultWorkflowId(mode = 'pentest') {
  if (mode === 'ctf-solver') return 'ctf-single'
  if (mode === 'code-audit') return 'code-review'
  return 'web-default'
}
