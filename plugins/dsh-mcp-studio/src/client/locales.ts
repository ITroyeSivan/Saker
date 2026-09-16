/** Locale namespace and dictionaries for the MCP Studio page. */

export const NS = 'mcp-studio'

export type StudioLocaleKey =
  | 'nav'
  | 'title'
  | 'subtitle'
  | 'save'
  | 'discard'
  | 'unsaved'
  | 'readOnly'
  | 'saveFailed'
  | 'errorsHeader'
  | 'loading'
  | 'statTotal'
  | 'statEnabled'
  | 'statConnected'
  | 'statTools'
  | 'addServer'
  | 'removeServer'
  | 'serverEnabled'
  | 'unnamedServer'
  | 'serverName'
  | 'serverNameHint'
  | 'transport'
  | 'command'
  | 'commandHint'
  | 'argsLine'
  | 'argsLineHint'
  | 'cwd'
  | 'cwdHint'
  | 'url'
  | 'urlHint'
  | 'env'
  | 'envHint'
  | 'headers'
  | 'headersHint'
  | 'addPair'
  | 'removePair'
  | 'pairValuePlaceholder'
  | 'toolCallTimeoutMs'
  | 'failOnStartupError'
  | 'failOnStartupErrorHint'
  | 'exposure'
  | 'exposureHint'
  | 'exposureAuto'
  | 'exposureDirect'
  | 'exposureProxy'
  | 'exposureHybrid'
  | 'exposureProxyBadgeHint'
  | 'proxyThreshold'
  | 'proxyThresholdHint'
  | 'directTools'
  | 'directToolsHint'
  | 'empty'
  | 'noMatch'
  | 'pasteJson'
  | 'pasteJsonHint'
  | 'pasteJsonPlaceholder'
  | 'importJson'
  | 'importDone'
  | 'errEmpty'
  | 'errBadJson'
  | 'errBadJsonAt'
  | 'errBadJsonPos'
  | 'errBadJsonToken'
  | 'errNotObject'
  | 'errNoServers'
  | 'errSkipped'
  | 'toolsTitle'
  | 'toolsSearchPlaceholder'
  | 'toolsEmpty'
  | 'toolsWaiting'
  | 'stateConnected'
  | 'stateMounting'
  | 'stateUnreachable'
  | 'stateError'
  | 'stateDisabled'
  | 'toolsUnit'
  | 'toolsPreviewHint'
  | 'fillTemplate'
  | 'formatJson'
  | 'copyJson'
  | 'copyThisServer'
  | 'copied'
  | 'copiedAll'
  | 'filterServers'
  | 'filter_all'
  | 'filter_connected'
  | 'filter_down'
  | 'filter_disabled'
  | 'transportHint'
  | 'transportInvalid'
  | 'compact'
  | 'comfortable'
  | 'execTitle'
  | 'execTime'
  | 'execServer'
  | 'execTool'
  | 'execDuration'
  | 'execStatus'
  | 'execOk'
  | 'execFailed'
  | 'testConnection'
  | 'diagElapsed'
  | 'diagProtocol'
  | 'diagServer'
  | 'diagTools'
  | 'execAllServers'
  | 'execClear'
  | 'execConfirmClear'
  | 'execMemoryHint'

export const en: Record<StudioLocaleKey, string> = {
  nav: 'MCP Studio',
  title: 'MCP Studio',
  subtitle: 'Every enabled server mounts live and exposes its tools to the model as mcp__<name>__<tool>. Saves apply immediately — no restart needed.',
  save: 'Save',
  discard: 'Discard',
  unsaved: 'Unsaved changes',
  readOnly: 'The settings document is read-only.',
  saveFailed: 'The last save was rejected. Review the values and save again.',
  errorsHeader: 'Complete the MCP configuration before saving.',
  loading: 'Loading…',
  statTotal: 'Servers',
  statEnabled: 'Enabled',
  statConnected: 'Connected',
  statTools: 'Tools',
  addServer: 'Add server',
  removeServer: 'Remove server',
  serverEnabled: 'Enabled',
  unnamedServer: '(unnamed server)',
  serverName: 'Server name',
  serverNameHint: 'Tool namespace; letters, digits, "_" and "-" only. Changing it renames every tool.',
  transport: 'Transport',
  command: 'Command',
  commandHint: 'Executable to spawn, e.g. npx or an absolute path.',
  argsLine: 'Arguments',
  argsLineHint: 'One line; quotes are honored, e.g. -y @modelcontextprotocol/server-github.',
  cwd: 'Working directory',
  cwdHint: 'Empty inherits the Harness working directory.',
  url: 'URL',
  urlHint: 'MCP endpoint, e.g. http://localhost:3000/mcp.',
  env: 'Environment',
  envHint: 'Extra variables merged over the child environment. Values are stored in your local settings file.',
  headers: 'Headers',
  headersHint: 'Extra request headers, e.g. Authorization. Values are stored in your local settings file.',
  addPair: 'Add entry',
  removePair: 'Remove',
  pairValuePlaceholder: 'value',
  toolCallTimeoutMs: 'Tool-call timeout (ms)',
  failOnStartupError: 'Fail mount on startup error',
  failOnStartupErrorHint: 'Otherwise an unreachable server simply contributes no tools.',
  exposure: 'Tool exposure',
  exposureHint: 'Direct puts one tool per server tool into every turn. Proxy publishes only mcp_search / mcp_call and fetches metadata on demand — cheaper for servers with many tools.',
  exposureAuto: 'Auto (proxy at or above the threshold)',
  exposureDirect: 'Direct (one tool per server tool)',
  exposureProxy: 'Proxy (mcp_search / mcp_call only)',
  exposureHybrid: 'Hybrid (proxy + promoted tools)',
  exposureProxyBadgeHint: 'Proxied: its tools are reachable through mcp_search / mcp_call rather than as individual entries.',
  proxyThreshold: 'Proxy threshold (tools)',
  proxyThresholdHint: 'Auto proxies the server once it advertises at least this many tools.',
  directTools: 'Promoted tools',
  directToolsHint: 'Comma-separated raw tool names to keep as individual entries while the rest stay behind the proxy. Names not advertised by the server are skipped.',
  empty: 'No MCP servers configured yet. Add one, or paste an existing config.',
  noMatch: 'No server matches the current filter or search. Clear them to see all servers.',
  pasteJson: 'Paste JSON',
  pasteJsonHint: 'Accepts Claude Desktop / VS Code / Cline / bare-map MCP config JSON; every entry becomes one row below.',
  pasteJsonPlaceholder: '{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": "..."}}}}',
  importJson: 'Import',
  importDone: 'imported',
  errEmpty: 'Nothing to parse — paste or type a config first.',
  errBadJson: 'That is not valid JSON.',
  errBadJsonAt: 'Invalid JSON at line {line}, column {column}.',
  errBadJsonPos: 'Invalid JSON at character {position}.',
  errBadJsonToken: 'Invalid JSON: unexpected {token}.',
  errNotObject: 'The top level must be a JSON object.',
  errNoServers: 'No server entries found. Expected {"mcpServers": {...}}, {"servers": {...}}, a bare {name: config} map, or a single server object.',
  errSkipped: 'Skipped "{name}": stdio needs a command, http needs a url.',
  toolsTitle: 'Tools',
  toolsSearchPlaceholder: 'Filter tools…',
  toolsEmpty: 'No tool matches this filter.',
  toolsWaiting: 'Tools appear here once the server connects.',
  stateConnected: 'connected',
  stateMounting: 'starting',
  stateUnreachable: 'not connected',
  stateError: 'failed',
  stateDisabled: 'disabled',
  toolsUnit: 'tools',
  toolsPreviewHint: 'View tools',
  fillTemplate: 'Template',
  formatJson: 'Format',
  copyJson: 'Copy JSON',
  copyThisServer: 'Copy this server as JSON',
  copied: 'Copied',
  copiedAll: 'Configuration copied as mcpServers JSON',
  filterServers: 'Filter servers by name, command, or url…',
  filter_all: 'All',
  filter_connected: 'Connected',
  filter_down: 'Not connected',
  filter_disabled: 'Disabled',
  transportHint: 'Type stdio or http.',
  transportInvalid: 'Enter stdio or http.',
  compact: 'Compact',
  comfortable: 'Comfortable',
  execTitle: 'Recent tool calls',
  execTime: 'Time',
  execServer: 'Server',
  execTool: 'Tool',
  execDuration: 'Duration',
  execStatus: 'Status',
  execOk: 'ok',
  execFailed: 'failed',
  testConnection: 'Test connection',
  diagElapsed: 'Handshake',
  diagProtocol: 'Protocol',
  diagServer: 'Server',
  diagTools: 'Tools',
  execAllServers: 'All servers',
  execClear: 'Clear log',
  execConfirmClear: 'Confirm clear?',
  execMemoryHint: 'In-memory log: up to {capacity} records, cleared on DSH restart.',
}

export const zh: Record<StudioLocaleKey, string> = {
  nav: 'MCP 工作台',
  title: 'MCP 工作台',
  subtitle: '每个启用的服务器实时挂载，并以 mcp__<名称>__<工具> 的形式向模型暴露工具。保存后即时生效，无需重启。',
  save: '保存',
  discard: '放弃修改',
  unsaved: '有未保存的修改',
  readOnly: '设置文档当前只读。',
  saveFailed: '上次保存被拒绝，请检查配置后重试。',
  errorsHeader: '请完善mcp内容配置信息后保存。',
  loading: '加载中…',
  statTotal: '服务器',
  statEnabled: '已启用',
  statConnected: '已连接',
  statTools: '工具',
  addServer: '添加服务器',
  removeServer: '删除服务器',
  serverEnabled: '启用',
  unnamedServer: '（未命名服务器）',
  serverName: '服务器名称',
  serverNameHint: '工具命名空间，仅限字母、数字、"_" 和 "-"。修改它会重命名全部工具。',
  transport: '传输方式',
  command: '启动命令',
  commandHint: '要启动的可执行文件，例如 npx 或绝对路径。',
  argsLine: '参数',
  argsLineHint: '一行写完，支持引号，例如 -y @modelcontextprotocol/server-github。',
  cwd: '工作目录',
  cwdHint: '留空则继承 Harness 的工作目录。',
  url: 'URL',
  urlHint: 'MCP 端点，例如 http://localhost:3000/mcp。',
  env: '环境变量',
  envHint: '额外注入子进程的环境变量。值明文保存在本地设置文件中。',
  headers: '请求头',
  headersHint: '额外的请求头，例如 Authorization。值明文保存在本地设置文件中。',
  addPair: '添加一项',
  removePair: '移除',
  pairValuePlaceholder: '值',
  toolCallTimeoutMs: '单次工具调用超时（毫秒）',
  failOnStartupError: '启动失败即报错',
  failOnStartupErrorHint: '关闭时，连不上的服务器只是不贡献任何工具。',
  exposure: '工具暴露方式',
  exposureHint: '直连=每个服务端工具都单独进模型上下文；代理=只暴露 mcp_search / mcp_call 两个入口，工具元数据按需拉取——工具多的服务器能用这个省上下文。',
  exposureAuto: '自动（达到阈值走代理）',
  exposureDirect: '直连（每个工具单独暴露）',
  exposureProxy: '代理（只留 mcp_search / mcp_call）',
  exposureHybrid: '混合（代理 + 指定工具直连）',
  exposureProxyBadgeHint: '已代理：它的工具通过 mcp_search / mcp_call 调用，不再逐个出现在工具列表里。',
  proxyThreshold: '代理阈值（工具数）',
  proxyThresholdHint: '自动模式下，服务端工具数达到该值即改走代理。',
  directTools: '直连的工具',
  directToolsHint: '逗号分隔的原始工具名：这些仍单独暴露，其余走代理。服务端没有的工具名会被跳过。',
  empty: '还没有配置 MCP 服务器。添加一个，或直接粘贴现成配置。',
  noMatch: '没有服务器匹配当前的筛选或搜索条件，清空后即可看到全部服务器。',
  pasteJson: '粘贴 JSON',
  pasteJsonHint: '支持 Claude Desktop / VS Code / Cline / 裸映射等常见 MCP 配置格式，每一条解析为下方一行。',
  pasteJsonPlaceholder: '{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": "..."}}}}',
  importJson: '导入',
  importDone: '已导入',
  errEmpty: '没有可解析的内容，请先粘贴或填写配置。',
  errBadJson: '这不是合法的 JSON。',
  errBadJsonAt: 'JSON 格式有误：第 {line} 行第 {column} 列。',
  errBadJsonPos: 'JSON 格式有误：第 {position} 个字符处。',
  errBadJsonToken: 'JSON 格式有误：出现意外字符 {token}。',
  errNotObject: '顶层必须是一个 JSON 对象。',
  errNoServers: '没有找到服务器条目：支持 {"mcpServers": {...}}、{"servers": {...}}、裸的 {名称: 配置} 映射，或单个服务器对象。',
  errSkipped: '已跳过「{name}」：stdio 需要 command，http 需要 url。',
  toolsTitle: '工具',
  toolsSearchPlaceholder: '筛选工具…',
  toolsEmpty: '没有匹配该筛选的工具。',
  toolsWaiting: '服务器连接后，工具会显示在这里。',
  stateConnected: '已连接',
  stateMounting: '启动中',
  stateUnreachable: '未连接',
  stateError: '连接失败',
  stateDisabled: '已禁用',
  toolsUnit: '个工具',
  toolsPreviewHint: '查看工具',
  fillTemplate: '填入模板',
  formatJson: '格式化',
  copyJson: '复制 JSON',
  copyThisServer: '复制此服务器 JSON',
  copied: '已复制',
  copiedAll: '已按 mcpServers 格式复制当前配置',
  filterServers: '按名称、命令或 URL 筛选服务器…',
  filter_all: '全部',
  filter_connected: '已连接',
  filter_down: '未连接',
  filter_disabled: '已禁用',
  transportHint: '输入 stdio 或 http。',
  transportInvalid: '请输入 stdio 或 http。',
  compact: '紧凑',
  comfortable: '舒适',
  execTitle: '最近工具调用',
  execTime: '时间',
  execServer: '服务器',
  execTool: '工具',
  execDuration: '耗时',
  execStatus: '状态',
  execOk: '成功',
  execFailed: '失败',
  testConnection: '测试连接',
  diagElapsed: '握手耗时',
  diagProtocol: '协议版本',
  diagServer: '服务器信息',
  diagTools: '工具数',
  execAllServers: '全部服务器',
  execClear: '清空记录',
  execConfirmClear: '确认清空？',
  execMemoryHint: '内存日志：最多保留 {capacity} 条，重启 DSH 后清空。',
}
