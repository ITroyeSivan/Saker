import { existsSync, readFileSync } from "node:fs";
import { RULES, computeDeny, enabledRules, matchByRule, DEFAULT_MODES } from "../lib/rules.js";
import { PACKS, deferredPackTools, enabledPacks, findPack, packTools, packsForMode } from "../lib/packs.js";
import { apply } from "../lib/index.js";

let pass = 0;
let fail = 0;
const ok = (label, condition) => {
  if (condition) { pass += 1; console.log(`ok   ${label}`); }
  else { fail += 1; console.log(`FAIL ${label}`); }
};
const plugins = new URL("../../", import.meta.url);
const readPlugin = (name, file = "lib/index.js") => {
  const url = new URL(`${name}/${file}`, plugins);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
};

const known = [
  "read", "write", "pwsh",
  "webshell_connect", "webshell_exec", "webshell_list", "webshell_db", "webshell_file",
  "ctf_challenge", "ctf_dispatch", "ctf_state", "ctf_steer",
  "redteam_finding_register", "redteam_context", "campaign_memory_write", "gates_list", "trace_recent",
  "nmap_portscan", "sqlmap_inject", "oob_probe", "asset_search", "asset_search_batch",
  "redteam_atlas_target", "redteam_coverage_mark", "operation_goal",
  "subagent", "subagent_fork", "workflow", "attack_plan", "attack_gate",
  "netexec_scan", "crackmapexec_scan", "impacket_suite", "access_confirm", "memshell_cli",
  "tool_pack",
];

{
  const pentest = computeDeny("pentest", known, RULES);
  ok("pentest hides CTF tools", pentest.includes("ctf_steer"));
  ok("pentest hides webshell tools but not the pack entry", pentest.includes("webshell_exec") && !pentest.includes("tool_pack"));
  ok("pentest hides high-risk post-exploitation and unmanaged delegation",
    ["redteam_atlas_target", "redteam_coverage_mark", "netexec_scan", "crackmapexec_scan", "impacket_suite",
      "access_confirm", "memshell_cli", "campaign_memory_write", "trace_recent", "subagent", "workflow"].every((name) => pentest.includes(name)));
  ok("pentest retains current evidence, scan and OOB tools",
    ["redteam_finding_register", "redteam_context", "nmap_portscan", "sqlmap_inject", "oob_probe", "asset_search"].every((name) => !pentest.includes(name)));

  const codeAudit = computeDeny("code-audit", known, RULES);
  ok("code-audit hides webshell and CTF tools", codeAudit.includes("webshell_exec") && codeAudit.includes("ctf_state"));
  ok("code-audit retains shared evidence tools", !codeAudit.includes("redteam_finding_register") && !codeAudit.includes("trace_recent"));
  ok("code-audit retains host and scanner tools", !codeAudit.includes("read") && !codeAudit.includes("nmap_portscan"));
  ok("code-audit hides the pentest-only pack entry", codeAudit.includes("tool_pack"));

  const ctf = computeDeny("ctf-solver", known, RULES);
  ok("ctf-solver retains CTF tools", !ctf.includes("ctf_challenge"));
  ok("ctf-solver hides pentest-only tools", ctf.includes("webshell_exec") && ctf.includes("tool_pack") && ctf.includes("operation_goal"));

  const standard = computeDeny("", known, RULES);
  ok("default mode hides scoped plugin tools", ["webshell_exec", "ctf_state", "operation_goal", "tool_pack"].every((name) => standard.includes(name)));
  ok("default mode retains host and unguarded tools", !standard.includes("read") && !standard.includes("nmap_portscan"));
  ok("empty tool list is harmless", computeDeny("code-audit", [], RULES).length === 0);
  ok("deny output is stable, unique and sorted", (() => {
    const one = computeDeny("", known, RULES);
    const two = computeDeny("", known, RULES);
    return JSON.stringify(one) === JSON.stringify(two) && new Set(one).size === one.length
      && JSON.stringify(one) === JSON.stringify([...one].sort());
  })());
}

{
  ok("enabledRules defaults to every rule", enabledRules().length === RULES.length);
  const off = enabledRules({ webshell: false });
  ok("a rule can be disabled by id", off.length === RULES.length - 1 && !off.some((rule) => rule.id === "webshell"));
  const matched = matchByRule(["webshell_exec", "ctf_state", "read"], RULES);
  ok("matchByRule reports only matching groups", matched.get("webshell")?.length === 1 && matched.get("ctf")?.length === 1 && !matched.has("security"));
}

{
  const tools = [
    "webshell_connect", "webshell_exec", "nmap_portscan", "dirsearch_dirs", "ffuf_fuzz",
    "nuclei_scan", "afrog_scan", "sqlmap_inject", "katana_crawl", "gau_urls",
    "whatweb_fingerprint", "wafw00f_detect", "asset_search", "tool_pack",
  ];
  const deferred = deferredPackTools("pentest", tools, PACKS);
  ok("pentest defers current scanner and fingerprint packs",
    ["nmap_portscan", "nuclei_scan", "whatweb_fingerprint"].every((name) => deferred.includes(name)));
  ok("retired WebShell tools are hidden by the defensive rule, not a product pack",
    !deferred.includes("webshell_exec") && computeDeny("pentest", known, RULES).includes("webshell_exec"));
  ok("pentest keeps the pack entry visible", !deferred.includes("tool_pack"));
  ok("code-audit gets no pentest pack filtering", deferredPackTools("code-audit", tools, PACKS).length === 0);
  ok("PACKS contains only supported product packs",
    PACKS.map((pack) => pack.id).join(",") === "task-workflow,asset-discovery,active-scan");
  ok("packs are scoped to pentest", packsForMode("pentest", PACKS).length === 3 && packsForMode("code-audit", PACKS).length === 0);
  ok("packs can be disabled by id", enabledPacks({ "active-scan": false }).length === PACKS.length - 1);
  ok("findPack rejects retired and unknown ids", findPack("webshell", PACKS) === null && findPack("nday", PACKS) === null);
  ok("retired WebShell installs still have a defensive hidden rule",
    RULES.find((rule) => rule.id === "webshell")?.modes.length === 1);
  ok("active-scan excludes fingerprint and asset tools",
    JSON.stringify(packTools(tools, findPack("active-scan", PACKS))) ===
      JSON.stringify(["afrog_scan", "dirsearch_dirs", "ffuf_fuzz", "gau_urls", "katana_crawl", "nmap_portscan", "nuclei_scan", "sqlmap_inject"]));
}

{
  const webshell = readPlugin("dsh-webshell-mgr");
  const webshellModes = /const ALLOWED_MODES = \[([^\]]*)\]/.exec(webshell);
  const webshellRule = RULES.find((rule) => rule.id === "webshell");
  ok("webshell rule mirrors the plugin allow-list",
    webshellModes !== null && JSON.stringify(webshellModes[1].split(",").map((item) => item.trim().replace(/['"]/g, "")).filter(Boolean))
      === JSON.stringify(webshellRule.modes));

  const ctfSource = readPlugin("dsh-ctf-observer");
  const ctfMode = /const MODE_ID = ["']([a-z-]+)["']/.exec(ctfSource);
  ok("CTF rule mirrors MODE_ID", ctfMode !== null && JSON.stringify([ctfMode[1]]) === JSON.stringify(RULES.find((rule) => rule.id === "ctf").modes));

  const securityRule = RULES.find((rule) => rule.id === "security");
  const sources = [
    ["dsh-redteam-results", /const MODES = \[([^\]]*)\]/],
    ["dsh-campaign-memory", /const MODE_IDS = \[([^\]]*)\]/],
    ["dsh-trace-vault", /const MODE_IDS = \[([^\]]*)\]/],
  ];
  for (const [plugin, pattern] of sources) {
    const source = readPlugin(plugin);
    const match = pattern.exec(source);
    const modes = match ? match[1].split(",").map((item) => item.trim().replace(/['"]/g, "")).filter(Boolean) : null;
    ok(`${plugin} modes match the security rule`, modes !== null && JSON.stringify(modes) === JSON.stringify(securityRule.modes));
  }
  ok("DEFAULT_MODES uses the same source of truth", JSON.stringify(DEFAULT_MODES) === JSON.stringify(securityRule.modes));
  ok("retired knowledge and Nday products are absent from active rules",
    !RULES.some((rule) => rule.prefixes.some((prefix) => /knowledge|nday/.test(prefix))));
}

{
  const toolNames = [
    "read", "nmap_portscan", "dirsearch_dirs", "ffuf_fuzz", "nuclei_scan", "afrog_scan",
    "sqlmap_inject", "katana_crawl", "gau_urls", "whatweb_fingerprint", "asset_search",
    "ctf_state", "webshell_connect", "webshell_exec", "tool_pack", "redteam_context",
    "operation_goal", "operation_scope", "operation_intent", "operation_task",
    "operation_progress", "operation_constraints", "operation_conclude",
  ];
  const handlers = {};
  const registered = [];
  const layers = new Map();
  const deferredScanners = ["nmap_portscan", "dirsearch_dirs", "ffuf_fuzz", "nuclei_scan", "afrog_scan", "sqlmap_inject", "katana_crawl", "gau_urls"];
  let scannerToolsReady = false;
  let layerId = 0;
  const denied = (name) => [...layers.values()].some((set) => set.has(name));
  const ctx = {
    tools: {
      schemas: () => toolNames.filter((name) => !deferredScanners.includes(name)).map((name) => ({ name })),
      register: (tool) => registered.push(tool),
    },
    logger: { info() {}, warn() {} },
    agentPresets: { composedPreset: () => "pentest" },
    on: (event, handler) => { handlers[event] = handler; },
  };
  apply(ctx, { log: false });
  const agent = {
    id: "agent-pack-test",
    ctx: {
      tools: {
        schemas: (scope) => scope === agent
          ? toolNames.filter((name) => !denied(name) && (scannerToolsReady || !deferredScanners.includes(name))).map((name) => ({ name }))
          : [],
        restrict(filter) {
          const id = ++layerId;
          layers.set(id, new Set(filter.deny));
          return () => layers.delete(id);
        },
      },
    },
  };
  handlers["agent/created"]({ agent });
  ok("agent/created tolerates preset scanners arriving later", !deferredScanners.some(denied));
  scannerToolsReady = true;
  handlers["agent/inbox/inserted"]({ agent });
  ok("late tools are folded into the requested packs", deferredScanners.every(denied) && denied("whatweb_fingerprint") && denied("asset_search"));
  ok("core evidence and pack entry remain visible", !denied("redteam_context") && !denied("tool_pack"));

  const toolPack = registered.find((tool) => tool.name === "tool_pack");
  ok("tool_pack is registered", Boolean(toolPack));
  const taskTools = toolNames.filter((name) => name.startsWith("operation_"));
  ok("task workflow starts hidden", taskTools.length === 7 && taskTools.every(denied));
  const loaded = await toolPack.execute({ action: "load", pack: "task-workflow" }, { agent });
  ok("task workflow can be loaded", loaded.ok && taskTools.every((name) => !denied(name)));
  await toolPack.execute({ action: "unload", pack: "task-workflow" }, { agent });
  ok("task workflow unloads again", taskTools.every(denied));

  const assetLoaded = await toolPack.execute({ action: "load", pack: "asset-discovery" }, { agent });
  ok("asset discovery restores asset tools only", assetLoaded.ok && !denied("asset_search") && !denied("whatweb_fingerprint") && denied("nmap_portscan"));
  await toolPack.execute({ action: "unload", pack: "asset-discovery" }, { agent });
  const scansLoaded = await toolPack.execute({ action: "load", pack: "active-scan" }, { agent });
  ok("active scan restores scanner tools", scansLoaded.ok && !denied("nmap_portscan") && !denied("nuclei_scan"));
  const list = await toolPack.execute({ action: "list" }, { agent });
  ok("list reports supported packs and no retired Nday or WebShell pack",
    list.ok && list.packs.some((pack) => pack.id === "active-scan" && pack.loaded)
      && !list.packs.some((pack) => ["nday", "webshell"].includes(pack.id)));
  handlers["agent/disposed"]({ agent });
  ok("agent disposal releases every filter", layers.size === 0);
}

{
  const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  ok("implementation only uses deny filters", /restrict\(\{\s*deny/.test(source) && !/restrict\(\{[^}]*allow/.test(source));
  ok("filter failures remain visible", /restrict 失败/.test(source) && /logger\?\.warn\?\./.test(source));
  ok("binding is idempotent and disposed", /states\.has\(agent\.id\)/.test(source) && /agent\/disposed/.test(source));
  ok("tool-scope logs both to host logger and stdout", /logger\?\.info\?\./.test(source) && /console\.log\('\[tool-scope\] '/.test(source));
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
