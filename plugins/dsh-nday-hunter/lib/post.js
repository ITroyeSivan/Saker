// Post-hit confirmation planner. This is deliberately a plan generator, not an
// executor: it constrains the next actions and blocks persistence until a
// self-hosted backend exists.

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function backendUrlForCommand(value) {
  return clean(value, 1000).replace(/\/+$/, "") || "<self-hosted-backend>";
}

export function classifyPrimitive(entry) {
  const text = [
    entry?.vulnClass,
    entry?.impact,
    ...(entry?.exploit?.primitives || []),
    ...(entry?.exploit?.tools || []),
  ].join(" ").toLowerCase();
  if (/deserial|反序列化|binaryformatter/.test(text)) return "deserialization";
  if (/upload|文件上传|write|写文件/.test(text)) return "file-write";
  if (/ssrf|服务端请求/.test(text)) return "ssrf";
  if (/rce|命令执行|code exec|代码执行|expression|表达式|ssti/.test(text)) return "rce";
  if (/auth|未授权|unauth|bypass|越权|认证/.test(text)) return "auth-bypass";
  return "unknown";
}

export function classifyMemoryBackend(config = {}) {
  const enabled = config?.enabled === true;
  const backendUrl = clean(config?.backendUrl, 1000);
  const cliPath = clean(config?.cliPath, 1000);
  if (!enabled) {
    return {
      ready: false,
      status: "blocked",
      reason: "未启用自建 memshell backend；公共 party.mem.mk 禁止用于真实测试",
      next: "在 设置 → 安全配置 → 内存马后端 填入自建地址并启用；本工具只做门禁与计划，不执行持久化",
    };
  }
  let url;
  try {
    url = new URL(backendUrl);
  } catch {
    return {
      ready: false,
      status: "blocked",
      reason: "memshell backend 地址不是合法 URL",
      next: "填写自建后端完整地址（如 http://127.0.0.1:8080）后重试",
    };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return {
      ready: false,
      status: "blocked",
      reason: `memshell backend 协议不支持：${url.protocol}`,
      next: "只允许 http/https 的自建后端地址",
    };
  }
  const host = url.hostname.toLowerCase();
  if (host === "party.mem.mk" || host.endsWith(".mem.mk") || host === "mem.mk" || host === "memshell.party") {
    return {
      ready: false,
      status: "blocked",
      reason: `公共 memshell 后端被拒绝：${host}`,
      next: "改指自建实例；公共 party.mem.mk 不得承载真实目标数据",
    };
  }
  return {
    ready: true,
    status: "ready-for-approval",
    reason: `已配置自建 backend：${host}${url.port ? `:${url.port}` : ""}`,
    next: "部署持久化组件仍需用户明确批准；本计划只登记 backend 与验证/清理步骤，不执行注入",
    host,
    cliPath,
  };
}

export function buildAccessPlan(entry, asset, options = {}) {
  const primitive = classifyPrimitive(entry);
  const oob = (entry?.verify?.oob || []).includes("dnslog");
  const memory = classifyMemoryBackend(options.memoryBackend || {});
  const cli = memory.cliPath || "memparty";
  const memoryCommands = memory.ready
    ? [
        `${cli} --api ${backendUrlForCommand(options.memoryBackend?.backendUrl)} version`,
        `${cli} --api ${backendUrlForCommand(options.memoryBackend?.backendUrl)} config servers`,
        `${cli} --api ${backendUrlForCommand(options.memoryBackend?.backendUrl)} gen --help`,
        `${cli} --api ${backendUrlForCommand(options.memoryBackend?.backendUrl)} connect --help`,
      ]
    : [];
  const commonEvidence = [
    "完整请求包与响应包（含时间、Host、路径、状态码）",
    "唯一 marker / OOB label 与回连记录",
    "基线请求与差分请求对照",
    "失败、超时、被 WAF 拦截等反证也要留档",
  ];
  const base = {
    schema: "saker.access-confirm/1",
    entryId: clean(entry?.id, 120),
    product: clean(entry?.product, 200),
    asset: clean(asset, 500),
    primitive,
    entryStatus: clean(entry?.status, 40),
    oobExpected: oob,
    evidenceToCapture: commonEvidence,
    approvalRequiredFor: [],
    allowedNow: [],
    forbidden: [
      "禁止破坏数据、删除文件、批量写入、重启服务或修改配置",
      "禁止在目标上部署 webshell / 内存马 / 后门或持久化组件",
      "禁止使用公共 party.mem.mk；持久化只能指向自建 backend",
      "禁止把未验证的筛选命中写成漏洞结论",
    ],
    stopConditions: [
      "目标出现服务异常、异常告警或不可逆影响风险时立即停止",
      "连续两次独立验证都无法复现时停止并标为未证实",
      "超出授权范围或发现横向目标时停止并回报",
    ],
    memoryShell: {
      status: memory.status,
      reason: memory.reason,
      next: memory.next,
      backendHost: memory.host || "",
      cliPath: memory.cliPath || "",
      cli,
      commands: memoryCommands,
    },
  };

  if (primitive === "deserialization") {
    base.allowedNow = [
      "优先使用 DNSLog / OOB 确认反序列化入口被处理",
      "只读观察错误类型、响应时间与回连标签",
    ];
    base.approvalRequiredFor = [
      "任何对象构造、gadget 链投放或命令执行载荷",
      "文件落地、回显命令或会话建立",
    ];
  } else if (primitive === "file-write") {
    base.allowedNow = [
      "先确认上传入口、鉴权前置与允许的类型/路径边界",
      "只在授权且可回滚的测试目标上准备最小 marker",
    ];
    base.approvalRequiredFor = [
      "上传任何文件（需用户明确批准）",
      "访问上传文件、覆盖既有文件或触发解析器",
    ];
    base.cleanup = "记录上传返回的确切路径；测试完成后经用户批准删除该 marker，并验证清单已移除";
  } else if (primitive === "ssrf") {
    base.allowedNow = [
      "用受控 DNSLog 域名确认请求是否发出",
      "只读取回连时间、来源地址与唯一 label",
    ];
    base.approvalRequiredFor = [
      "访问云元数据、内网控制面或任何真实内部服务",
      "读取/回传内网数据或凭据",
    ];
  } else if (primitive === "auth-bypass") {
    base.allowedNow = [
      "只读身份/权限检查接口，确认当前身份与授权差异",
      "保存未认证与正常会话的对照请求",
    ];
    base.approvalRequiredFor = [
      "任何写操作、数据导出、批量读取或角色变更",
      "使用非测试账号读取真实业务数据",
    ];
  } else if (primitive === "rce") {
    base.allowedNow = [
      "优先用 OOB 确认命令处理路径",
      "回显可用时只执行只读 whoami / id / pwd / echo <marker>",
    ];
    base.approvalRequiredFor = [
      "除只读身份命令外的任何命令",
      "文件写入、下载工具、横向移动或会话建立",
    ];
  } else {
    base.allowedNow = ["只做只读观察与证据收集"];
    base.approvalRequiredFor = ["任何改变目标状态的动作"];
  }

  if (!oob) {
    base.allowedNow.push("该条目未声明 DNSLog；优先用响应差分/错误签名确认，仍保持最小影响");
  }
  if (options.bucketId) base.bucketId = clean(options.bucketId, 120);
  if (options.parentTaskId) base.parentTaskId = clean(options.parentTaskId, 120);
  return base;
}

export function renderAccessPlan(plan) {
  const lines = [
    `# 访问确认计划：${plan.entryId}`,
    "",
    `- 资产：${plan.asset}`,
    `- 原语：${plan.primitive}`,
    `- 条目状态：${plan.entryStatus}`,
    `- DNS 带外：${plan.oobExpected ? "条目要求，优先使用 oob_probe" : "条目未声明"}`,
    "",
    "## 现在允许",
    ...plan.allowedNow.map((item) => `- ${item}`),
    "",
    "## 必须明确批准",
    ...plan.approvalRequiredFor.map((item) => `- ${item}`),
    "",
    "## 禁止",
    ...plan.forbidden.map((item) => `- ${item}`),
    "",
    "## 证据",
    ...plan.evidenceToCapture.map((item) => `- ${item}`),
    "",
    "## 停止条件",
    ...plan.stopConditions.map((item) => `- ${item}`),
    "",
    "## 持久化 / 内存马",
    `- 状态：${plan.memoryShell.status === "blocked" ? "暂不支持" : plan.memoryShell.status === "ready-for-approval" ? "自建后端已就绪，部署仍需明确批准" : plan.memoryShell.status}`,
    `- 原因：${plan.memoryShell.reason}`,
    `- 后续：${plan.memoryShell.next}`,
    ...(plan.memoryShell.backendHost ? [`- 自建 backend：${plan.memoryShell.backendHost}`] : []),
    ...(plan.memoryShell.commands?.length
      ? ["", "### 自建后端命令模板（仅在用户明确批准后执行）", ...plan.memoryShell.commands.map((command) => `- \`${command}\``)]
      : []),
  ];
  if (plan.cleanup) lines.push("", `## 清理\n- ${plan.cleanup}`);
  lines.push("", "> 本计划不执行任何动作；执行仍须人工批准并遵守目标授权边界。");
  return lines.join("\n") + "\n";
}
