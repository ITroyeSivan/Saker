#!/usr/bin/env node
// Project workbench regression: actionable attention items must survive the
// transition from raw state files to the generated JSON/HTML snapshot.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(join(tmpdir(), "saker-project-status-"));
let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`ok   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

try {
  writeFileSync(join(workspace, "operation-state.json"), JSON.stringify({
    goal: "Project status regression",
    criteria: [{ id: "c1", text: "finish the test", status: "open" }],
    intents: [{
      id: "i1",
      summary: "recover interrupted work",
      status: "open",
      task: { state: "interrupted", error: "heartbeat expired" },
    }, {
      id: "i2",
      summary: "conflicting subagent result",
      status: "open",
      task: {
        state: "succeeded",
        result: "模型说完成了",
        conflicts: [{ at: "2026-09-18T00:00:00.000Z", from: "succeeded", to: "failed", detail: "子代理随后报失败" }],
      },
    }],
  }, null, 2));
  writeFileSync(join(workspace, "scan-reconcile.md"), "# reconcile\n| scanner | hit | 待处置 |\n", "utf8");
  writeFileSync(join(workspace, "gate-log.md"), "FAIL stage gate sample\n", "utf8");
  writeFileSync(join(workspace, "evidence-index.md"), "| E1 | now | artifact | cmd | consumer |\n", "utf8");

  const traceDir = join(workspace, "trace-vault");
  mkdirSync(traceDir, { recursive: true });
  const { openStore, beginTrace, recoverStaleRunning } = await import("../plugins/dsh-trace-vault/lib/store.js");
  const traceStore = openStore(join(traceDir, "traces.db"));
  try {
    beginTrace(traceStore, { id: "trace-1", sessionId: "s1", mode: "pentest", tool: "nuclei_scan", args: "{}" });
    traceStore.db.prepare("UPDATE traces SET last_seen = '2000-01-01 00:00:00' WHERE id = 'trace-1'").run();
    recoverStaleRunning(traceStore);
  } finally {
    traceStore.close();
  }

  const memoryDir = join(workspace, "campaign-memory");
  mkdirSync(memoryDir, { recursive: true });
  const { openStore: openMemoryStore, writeMemory } = await import("../plugins/dsh-campaign-memory/lib/store.js");
  const memoryStore = openMemoryStore(join(memoryDir, "memory.db"));
  try {
    const workspaceName = basename(workspace);
    const workspaceKey = `${workspaceName}@${createHash("sha256").update(workspace).digest("hex").slice(0, 8)}`;
    writeMemory(memoryStore, {
      mode: "pentest",
      kind: "playbook",
      title: "project memory",
      content: "use the verified path first",
      workspace: workspaceName,
      workspace_key: workspaceKey,
    });
  } finally {
    memoryStore.close();
  }

  const jsonOut = join(workspace, "status.json");
  const htmlOut = join(workspace, "status.html");
  const result = spawnSync(process.execPath, [
    join(ROOT, "scripts", "project-status.mjs"),
    "--workspace", workspace,
    "--home", workspace,
    "--json", jsonOut,
    "--html", htmlOut,
  ], { cwd: ROOT, encoding: "utf8" });
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  ok("project-status exits zero", result.status === 0, out.trim());
  const report = JSON.parse(readFileSync(jsonOut, "utf8"));
  const kinds = report.attention.map((item) => item.kind);
  ok("attention includes open criterion", kinds.includes("未收口准则"));
  ok("attention includes open intent", kinds.includes("未收口意图"));
  ok("attention includes interrupted task", kinds.includes("中断任务"));
  ok("attention includes task result conflict", kinds.includes("任务结果冲突")
    && report.attention.some((item) => item.kind === "任务结果冲突" && item.text.includes("子代理随后报失败")));
  ok("attention includes interrupted trace", kinds.includes("中断工具调用"));
  ok("attention includes pending scan rows", kinds.includes("扫描对账"));
  ok("attention includes failed gate", kinds.includes("阶段门禁"));
  ok("unified jobs include trace-vault row", report.jobs.combined.some((job) => job.source === "trace-vault" && job.state === "interrupted"));
  ok("project memory included", report.memory.total === 1 && report.memory.rows[0]?.title === "project memory");
  const html = readFileSync(htmlOut, "utf8");
  ok("HTML includes attention section and count", html.includes("需要处理") && html.includes("中断任务"));

  // 台账存在但没登记目标：不能显示成「0/0 closed」这种看起来健康的状态。
  const noGoal = join(workspace, "no-goal");
  mkdirSync(noGoal, { recursive: true });
  writeFileSync(join(noGoal, "operation-state.json"), JSON.stringify({
    version: 1, mode: "pentest", goal: "", criteria: [], intents: [], gates: {},
  }, null, 2));
  const noGoalJson = join(noGoal, "status.json");
  const noGoalHtml = join(noGoal, "status.html");
  const noGoalResult = spawnSync(process.execPath, [
    join(ROOT, "scripts", "project-status.mjs"),
    "--workspace", noGoal,
    "--home", noGoal,
    "--json", noGoalJson,
    "--html", noGoalHtml,
  ], { cwd: ROOT, encoding: "utf8" });
  const noGoalOut = `${noGoalResult.stdout || ""}${noGoalResult.stderr || ""}`;
  const noGoalReport = JSON.parse(readFileSync(noGoalJson, "utf8"));
  ok("no-goal ledger: goalRegistered=false", noGoalReport.goalRegistered === false, noGoalOut.trim());
  ok("no-goal ledger: attention 里点名目标契约",
    noGoalReport.attention.some((item) => item.kind === "目标契约" && /0\/0/.test(item.text)));
  ok("no-goal ledger: 控制台不报「0/0 closed」",
    /criteria: 未登记/.test(noGoalOut) && !/criteria: 0\/0/.test(noGoalOut), noGoalOut.trim().replace(/\n/g, " | "));
  const noGoalHtmlText = readFileSync(noGoalHtml, "utf8");
  ok("no-goal ledger: HTML 准则卡片显示未登记（告警色）而不是 0/0",
    /<span class="muted">准则<\/span><b class="warn">未登记<\/b>/.test(noGoalHtmlText));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
