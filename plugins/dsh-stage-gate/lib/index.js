import os from "node:os";

// ── 平台数据根（$DSH_HOME）────────────────────────────────────────────
// 宿主按 $DSH_HOME 装配 profiles/会话/存储；插件一律跟随，避免「一半落 A 一半落 B」。
// 未设置时等价于 ~/.dsh，故对既有用户是零行为变更。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// dsh-stage-gate — the runtime half of the security presets' stage-gate discipline.
//
// The playbooks define gates as text contracts (ad-playbook 子代理编排, pentest/audit/re/av
// 编排章); this plugin turns the STRUCTURAL subset of those contracts into a tool the model
// must call and cannot self-grade: files present, non-empty, required markers present, table
// rows complete, artifact provenance hashed. Semantic gates (call-chain agreement, reviewer
// confirm-or-challenge, boundary judgment) stay in the reviewers' hands and are surfaced as
// `manual` entries so the model cannot mistake a structural pass for a full pass.
//
// Verdicts append to <workspace>/gate-log.md — the audit trail the report chapter consumes.
//
// 目标契约与运行状态（operation-state.json）：operation_goal 把任务目标登记为带成功准则的
// 可判定契约；stage_gate 每次判定自动同步 gates 进度；operation_progress 逐条收口准则。
// route-boost 读同一文件在中断后投递恢复盘，sec-enforce 的报告门在准则未全 met 时拦截
// reports/ 落盘——「目标可判定、进度可恢复、终态有门槛」共用这一份文件契约。

import fs from "node:fs";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ROUTE_PATH as PROJECT_ROUTE, createProjectHandler } from "./project-channel.mjs";

//#region gate schema

/**
 * Check kinds (v1, structural only):
 *  - file        : file exists and is non-empty
 *  - markers     : file contains every marker string
 *  - hexHash     : file contains a 64-hex hash (sha256)
 *  - table       : file holds >= minRows table rows, each with >= minCells non-empty cells
 *  - provenance  : artifacts/ has >=1 <sub>/provenance.md carrying a 64-hex hash
 */
const GATES = {
	pentest: {
		"P1": {
			title: "资产与环境基线",
			checks: [
				{ kind: "file", file: "assets.md" },
				{ kind: "markers", file: "assets.md", markers: ["WAF", "速率"] },
				{ kind: "table", file: "assets.md", minRows: 2, minCells: 2 },
				{ kind: "file", file: "evidence-index.md" },
				{ kind: "markers", file: "evidence-index.md", markers: ["tool-plane", "MCP"] },
				{ kind: "table", file: "evidence-index.md", minRows: 1, minCells: 2 }
			],
			manual: []
		},
		"P2": {
			title: "finding 对照三件套 + 复核记录",
			requiresFile: true,
			fileHint: "该 finding 的六字段报告文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["基线", "差分", "marker", "复核"] }
			],
			manual: ["对照三件套的语义成立（差分真实翻转、marker 逐字回显）与复核员确认/双签记录由复核员判定"]
		},
		"P3": {
			title: "覆盖度（资产×漏洞类全集）+ 复核汇总账",
			checks: [
				{ kind: "file", file: "coverage-matrix.md" },
				{ kind: "table", file: "coverage-matrix.md", minRows: 3, minCells: 3 },
				{ kind: "file", file: "review-log.md" },
				{ kind: "markers", file: "review-log.md", markers: ["复核"] }
			],
			manual: ["N-A 格理由是否成立由复核员抽查", "review-log 复核结论（确认/挑战）语义由复核员判定；跨 harness 双签（DSH+claude/codex 复核一致）才可在行内标「双签」"]
		}
	},
	"code-audit": {
		"A1": {
			title: "前置识别 + 面映射",
			checks: [
				{ kind: "file", file: "surface-map.md" },
				{ kind: "markers", file: "surface-map.md", markers: ["入口", "sink", "深度"] },
				{ kind: "file", file: "evidence-index.md" },
				{ kind: "markers", file: "evidence-index.md", markers: ["tool-plane", "MCP"] }
			],
			manual: ["已知漏洞核对结论与深度分级合理性"]
		},
		"A2": {
			title: "双链一致（审计工人链 vs 追踪员链）",
			requiresFile: true,
			fileHint: "该 finding 的调用链记录文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["entry", "sink"] }
			],
			manual: ["两条链语义一致由复核员判定；不一致退回重追或降疑似"]
		},
		"A3": {
			title: "覆盖度（模块×sink 全集）+ 扫描命中对账",
			checks: [
				{ kind: "file", file: "audit-coverage-matrix.md" },
				{ kind: "table", file: "audit-coverage-matrix.md", minRows: 3, minCells: 3 },
				{ kind: "file", file: "scan-reconcile.md" },
				{ kind: "markers", file: "scan-reconcile.md", markers: ["确认", "误报"] }
			],
			manual: ["命中数量守恒（扫描器报告数=终态数）由复核员核对"]
		}
	},
	"binary-analysis": {
		"B0": {
			title: "样本登记门",
			checks: [
				{ kind: "provenance", dir: "artifacts" }
			],
			manual: ["来源与日期的真实性"]
		},
		"B1": {
			title: "还原完整性三验",
			requiresFile: true,
			fileHint: "该还原产物的验证记录文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["dex", "IAT", "可运行"] },
				{ kind: "hexHash", file: "$file" }
			],
			manual: ["三项验证的语义结论（通过/不通过）由复核员判定；不过=疑似"]
		},
		"B2": {
			title: "分析维度覆盖 + 假设台账终态",
			checks: [
				{ kind: "file", file: "analysis-coverage.md" },
				{ kind: "table", file: "analysis-coverage.md", minRows: 3, minCells: 3 },
				{ kind: "file", file: "hypothesis-ledger.md" },
				{ kind: "markers", file: "hypothesis-ledger.md", markers: ["确认", "证伪"] }
			],
			manual: ["未决假设不得写成事实"]
		}
	},
	"attack-defense": {
		"recon": {
			title: "阶段①侦察产物",
			checks: [
				{ kind: "file", file: "assets.md" },
				{ kind: "table", file: "assets.md", minRows: 2, minCells: 2 },
				{ kind: "file", file: "evidence-index.md" },
				{ kind: "markers", file: "evidence-index.md", markers: ["tool-plane", "MCP"] },
				{ kind: "table", file: "evidence-index.md", minRows: 1, minCells: 2 }
			],
			manual: []
		},
		"breach": {
			title: "阶段②突破产物（路径台账）",
			checks: [
				{ kind: "file", file: "paths-ledger.md" },
				{ kind: "markers", file: "paths-ledger.md", markers: ["candidate", "chosen"] },
				{ kind: "table", file: "paths-ledger.md", minRows: 1, minCells: 3 }
			],
			manual: ["已验证 finding 的证据由复核员 gate-pass 判定"]
		},
		"lateral": {
			title: "阶段③横向（前置=已验证突破）",
			requiresFile: true,
			fileHint: "横向证据记录文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["授权"] }
			],
			manual: ["前置突破已验证、范围合规由复核员判定"]
		},
		"persistence": {
			title: "阶段④持久化登记",
			checks: [
				{ kind: "file", file: "persistence-registry.md" },
				{ kind: "markers", file: "persistence-registry.md", markers: ["手动排除"] },
				{ kind: "table", file: "persistence-registry.md", minRows: 1, minCells: 4 }
			],
			manual: ["登记即满足；排除步骤可执行性由用户验收"]
		},
		"report": {
			title: "阶段⑤报告完整性",
			requiresFile: true,
			fileHint: "总评估报告文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["漏洞名称", "ATT&CK", "detection gap", "持久化清单", "路径台账", "阶段终态"] },
				{ kind: "file", file: "op-traces.md" },
				{ kind: "markers", file: "op-traces.md", markers: ["shell 地址", "ssh 密钥", "创建的用户"] },
				{ kind: "table", file: "op-traces.md", minRows: 1, minCells: 4 }
			],
			manual: ["每个 finding 带复核 gate-pass 签名由报告员保证", "操作痕迹台账须覆盖全部已登记 webshell/ssh 密钥/新建用户（无则填「无」行）"]
		}
	},
	"av-evasion": {
		"V1": {
			title: "实验计划门（三声明）",
			checks: [
				{ kind: "file", file: "experiment-plan.md" },
				{ kind: "markers", file: "experiment-plan.md", markers: ["测试环境", "产物去向", "持久化预案"] }
			],
			manual: ["三声明语义成立由总控判定：测试环境为本地或任务授权目标；产物去向（实验室目录或任务工作区）如实；涉及持久化则预案与登记制（persistence-registry，含手动排除步骤）一致"]
		},
		"V3": {
			title: "配对完整（技术↔检测双向镜像）",
			requiresFile: true,
			fileHint: "该轮实验报告文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["技术侧", "检测侧"] }
			],
			manual: ["镜像两侧语义对称（同一技术同一实现）由复核员判定"]
		},
		"V2": {
			title: "证据三件",
			requiresFile: true,
			fileHint: "判定日志文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["构建", "判定"] },
				{ kind: "hexHash", file: "$file" }
			],
			manual: ["哈希一致、时间戳合理由复核员核对"]
		},
		"V4": {
			title: "结论外推检查",
			requiresFile: true,
			fileHint: "实验结论文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["已测环境"] }
			],
			manual: ["结论范围 ≤ 已测环境范围——语义判断由总控/复核员执行"]
		}
	},
	"incident-response": {
		"I1": {
			title: "证据保全登记",
			checks: [
				{ kind: "file", file: "evidence-preservation.md" },
				{ kind: "markers", file: "evidence-preservation.md", markers: ["保全项", "取证命令"] },
				{ kind: "table", file: "evidence-preservation.md", minRows: 1, minCells: 4 },
				{ kind: "file", file: "evidence-index.md" },
				{ kind: "table", file: "evidence-index.md", minRows: 1, minCells: 2 }
			],
			manual: ["保全动作可追溯、取证只读优先由复核员判定"]
		},
		"I2": {
			title: "时间线与攻击链还原",
			checks: [
				{ kind: "file", file: "attack-timeline.md" },
				{ kind: "markers", file: "attack-timeline.md", markers: ["时间节点", "可疑IP", "证据"] },
				{ kind: "table", file: "attack-timeline.md", minRows: 3, minCells: 4 }
			],
			manual: ["链上断点如实标注「未知」；节点证据编号可追溯由复核员判定"]
		},
		"I3": {
			title: "失陷定性收口",
			checks: [
				{ kind: "file", file: "compromise-verdict.md" },
				{ kind: "markers", file: "compromise-verdict.md", markers: ["定性", "证据"] },
				{ kind: "table", file: "compromise-verdict.md", minRows: 1, minCells: 4 }
			],
			manual: ["confirmed/疑似/排除三态语义由复核员判定；疑似不得进 confirmed"]
		},
		"I4": {
			title: "处置建议（清理清单完整性）",
			checks: [
				{ kind: "file", file: "remediation-checklist.md" },
				{ kind: "markers", file: "remediation-checklist.md", markers: ["处置步骤", "验证方式", "用户确认"] },
				{ kind: "table", file: "remediation-checklist.md", minRows: 1, minCells: 4 }
			],
			manual: ["删除类操作标注「用户确认后执行」；步骤可执行性由用户验收"]
		},
		"I5": {
			title: "报告完整性",
			requiresFile: true,
			fileHint: "应急溯源报告文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["时间线", "失陷原因", "ATT&CK", "处置建议", "证据索引"] }
			],
			manual: ["每个 finding 带复核 gate-pass 签名由报告员保证"]
		}
	},
	"cloud-security": {
		"C1": {
			title: "云资产与暴露面测绘",
			checks: [
				{ kind: "file", file: "cloud-assets.md" },
				{ kind: "markers", file: "cloud-assets.md", markers: ["资产", "暴露面", "凭证", "基线快照"] },
				{ kind: "table", file: "cloud-assets.md", minRows: 2, minCells: 4 },
				{ kind: "file", file: "evidence-index.md" },
				{ kind: "table", file: "evidence-index.md", minRows: 1, minCells: 2 }
			],
			manual: ["暴露面完整、凭证来源可追溯、基线快照可还原由复核员判定"]
		},
		"C2": {
			title: "攻击路径验证",
			checks: [
				{ kind: "file", file: "attack-paths.md" },
				{ kind: "markers", file: "attack-paths.md", markers: ["入口", "身份", "权限", "资源", "影响", "证据"] },
				{ kind: "table", file: "attack-paths.md", minRows: 1, minCells: 6 }
			],
			manual: ["每条路径影响证明级证据、四要素闭环无悬空由复核员判定"]
		},
		"C3": {
			title: "横向与持久化",
			checks: [
				{ kind: "file", file: "lateral-persistence.md" },
				{ kind: "markers", file: "lateral-persistence.md", markers: ["授权", "验证状态", "证据", "排除步骤"] },
				{ kind: "table", file: "lateral-persistence.md", minRows: 1, minCells: 5 }
			],
			manual: ["超范围项标「未执行」零虚构；授权内持久化已登记手动排除步骤"]
		},
		"C4": {
			title: "权限链收口",
			checks: [
				{ kind: "file", file: "privilege-chains.md" },
				{ kind: "markers", file: "privilege-chains.md", markers: ["起点", "权限", "终点", "证据"] },
				{ kind: "table", file: "privilege-chains.md", minRows: 1, minCells: 4 }
			],
			manual: ["每链独立证据、无悬空链、疑似不得进 confirmed 由复核员判定"]
		},
		"C5": {
			title: "检测缺口评估",
			checks: [
				{ kind: "file", file: "detection-gap.md" },
				{ kind: "markers", file: "detection-gap.md", markers: ["审计", "检测", "终态"] },
				{ kind: "table", file: "detection-gap.md", minRows: 1, minCells: 3 }
			],
			manual: ["每关键路径配检测侧结论、终态三选一禁留空由复核员判定"]
		},
		"C6": {
			title: "环境还原",
			checks: [
				{ kind: "file", file: "environment-restore.md" },
				{ kind: "markers", file: "environment-restore.md", markers: ["对象", "还原方式", "验证状态"] },
				{ kind: "table", file: "environment-restore.md", minRows: 1, minCells: 3 }
			],
			manual: ["测试改动全登记、还原可验证、删除类标「用户确认后执行」"]
		},
		"C7": {
			title: "报告完整性",
			requiresFile: true,
			fileHint: "云安全评估报告文件路径",
			checks: [
				{ kind: "markers", file: "$file", markers: ["攻击路径", "配置缺陷", "权限链", "检测缺口", "环境还原", "证据索引", "阶段终态"] }
			],
			manual: ["每条攻击路径带复核 gate-pass 签名由报告员保证"]
		}
	},
	"ctf-solver": {
		board: {
			title: "题面登记",
			checks: [
				{ kind: "file", file: "challenge-board.md" },
				{ kind: "markers", file: "challenge-board.md", markers: ["题名", "模块", "线索"] },
				{ kind: "table", file: "challenge-board.md", minRows: 1, minCells: 3 },
				{ kind: "file", file: "evidence-index.md" },
				{ kind: "markers", file: "evidence-index.md", markers: ["tool-plane", "MCP"] },
				{ kind: "table", file: "evidence-index.md", minRows: 1, minCells: 2 }
			],
			manual: ["每行线索已梳理、模块判定合理由总控判定"]
		},
		flag: {
			title: "flag 台账收口",
			checks: [
				{ kind: "file", file: "flag-ledger.md" },
				{ kind: "markers", file: "flag-ledger.md", markers: ["flag", "验证", "状态"] },
				{ kind: "table", file: "flag-ledger.md", minRows: 1, minCells: 4 }
			],
			manual: ["每个「已解」flag 带验证证据；未解标卡点——不猜不撞不伪造由复核员判定"]
		}
	}
};

//#endregion

//#region pure validators (exported for tests)

const HEX64 = /[a-f0-9]{64}/i;

function readSafe(fsm, p) {
	try { return fsm.readFileSync(p, "utf8"); } catch { return undefined; }
}

/** Parse markdown table rows; separator rows (|---|) excluded. Returns per-row non-empty cell counts. */
export function tableRows(text) {
	const rows = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("|")) continue;
		const cells = line.split("|").slice(1, line.endsWith("|") ? -1 : undefined).map((c) => c.trim());
		if (cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
		rows.push({ line: i + 1, nonEmpty: cells.filter((c) => c.length > 0).length });
	}
	return rows;
}

function runCheck(fsm, check, resolve) {
	const file = check.file === "$file" ? resolve.file : check.file && resolve.workspace(check.file);
	switch (check.kind) {
		case "file": {
			const text = file && readSafe(fsm, file);
			return { ok: !!text && text.trim().length > 0, detail: file ?? "(missing $file)" };
		}
		case "markers": {
			const text = file && readSafe(fsm, file);
			if (!text) return { ok: false, detail: `${file ?? "(missing $file)"} 不存在` };
			const missing = check.markers.filter((m) => !text.includes(m));
			return { ok: missing.length === 0, detail: missing.length ? `${file} 缺标记: ${missing.join(", ")}` : file };
		}
		case "hexHash": {
			const text = file && readSafe(fsm, file);
			return { ok: !!text && HEX64.test(text), detail: file ?? "(missing $file)" };
		}
		case "table": {
			const text = file && readSafe(fsm, file);
			if (!text) return { ok: false, detail: `${file ?? "(missing $file)"} 不存在` };
			const rows = tableRows(text);
			const minRows = check.minRows ?? 1;
			const minCells = check.minCells ?? 1;
			const incomplete = rows.filter((r) => r.nonEmpty < minCells);
			const ok = rows.length >= minRows && incomplete.length === 0;
			// 报错必须自带可执行修法：说明「要几行、每行几个非空格、哪几行差在哪」，
			// 否则模型只能去翻 node_modules 源码反推需求。
			const need = `需 ≥${minRows} 行、每行 ≥${minCells} 个非空单元格`;
			const short = incomplete.map((r) => `L${r.line}(${r.nonEmpty}格)`).join("、");
			let detail;
			if (rows.length === 0) {
				detail = `${file}: 未检测到 Markdown 表格行（${need}）；表格行须以 | 开头，形如 | 列1 | 列2 |`;
			} else if (incomplete.length > 0) {
				const scope = incomplete.length === rows.length ? "全部" : "部分";
				detail = `${file}: 表格共 ${rows.length} 行，${scope}行不达标：${short}（${need}）`;
			} else if (rows.length < minRows) {
				detail = `${file}: 表格仅 ${rows.length} 行，行数不足（${need}）`;
			} else {
				detail = `${file}: 表格共 ${rows.length} 行，各行列数达标（${need}）`;
			}
			return { ok, detail };
		}
		case "provenance": {
			const dir = resolve.workspace(check.dir ?? "artifacts");
			let entries = [];
			try { entries = fsm.readdirSync(dir, { withFileTypes: true }); } catch { return { ok: false, detail: `${dir} 不存在` }; }
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				const p = path.join(dir, e.name, "provenance.md");
				const text = readSafe(fsm, p);
				if (text && HEX64.test(text)) return { ok: true, detail: p };
			}
			return { ok: false, detail: `${dir}/*/provenance.md 无带哈希登记` };
		}
		default:
			return { ok: false, detail: `unknown check kind ${check.kind}` };
	}
}

/**
 * Validate one gate. Pure apart from `fsm` (inject node:fs in production, fixtures in tests).
 * @returns {{ mode: string, stage: string, title: string, pass: boolean, checks: object[],
 *             manual: string[], missing: string[] }}
 */
export function runGate(fsm, { mode, stage, workspace, file }) {
	const gate = GATES[mode]?.[stage];
	if (!gate) throw new Error(`unknown gate ${mode}/${stage}; valid stages: ${Object.keys(GATES[mode] ?? {}).join(", ") || "(unknown mode)"}`);
	const resolve = {
		workspace: (f) => path.resolve(workspace, f),
		file: file ? (path.isAbsolute(file) ? path.resolve(file) : path.resolve(workspace, file)) : undefined
	};
	if (gate.requiresFile && !file) throw new Error(`gate ${mode}/${stage} 需要 file 参数（${gate.fileHint}）`);
	const results = gate.checks.map((check) => ({ id: `${check.kind}:${check.file ?? check.dir}`, ...runCheck(fsm, check, resolve) }));
	// 报告门追加覆盖度算术对账：scope 已登记才激活（未登记=零影响）。
	// 目标文件：传参 file 优先，否则门 schema 的第一个固定文件。
	if (REPORT_GATES[mode] === stage) {
		let reportFile = resolve.file;
		if (!reportFile) {
			const fixed = gate.checks.find((c) => c.file && c.file !== "$file");
			if (fixed) reportFile = path.resolve(workspace, fixed.file);
		}
		if (reportFile) {
			const cov = coverageCheck(fsm, workspace, reportFile);
			if (cov) results.push({ id: "coverage:report", kind: "coverage", file: path.basename(reportFile), ...cov });
		}
	}
	return {
		mode,
		stage,
		title: gate.title,
		pass: results.every((r) => r.ok),
		checks: results,
		manual: gate.manual,
		missing: results.filter((r) => !r.ok).map((r) => `${r.id} — ${r.detail}`)
	};
}

/** Schema summary for gates_list. */
export function listGates(mode) {
	if (mode && !GATES[mode]) throw new Error(`unknown mode ${mode}; valid: ${Object.keys(GATES).join(", ")}`);
	const modes = mode ? { [mode]: GATES[mode] } : GATES;
	return Object.fromEntries(Object.entries(modes).map(([m, stages]) => [
		m,
		Object.fromEntries(Object.entries(stages).map(([s, g]) => [s, {
			title: g.title,
			files: [...new Set(g.checks.filter((c) => c.file && c.file !== "$file").map((c) => c.file))],
			requiresFile: !!g.requiresFile,
			manual: g.manual
		}]))
	]));
}

//#endregion

//#region plugin

const name = "stage-gate";
const inject = ["tools", "agentPresets", "webServer", "webRuntime"];

/** Append the verdict line to <workspace>/gate-log.md (audit trail); write failure never flips the verdict. */
function appendGateLog(workspace, verdict) {
	const line = `| ${new Date().toISOString()} | ${verdict.mode}/${verdict.stage} | ${verdict.pass ? "pass" : "fail"} | ${verdict.missing.join(" ; ") || "-"} |\n`;
	const log = path.join(workspace, "gate-log.md");
	let head = "";
	try { head = fs.readFileSync(log, "utf8"); } catch { head = "# gate-log（阶段门禁判定审计 trail）\n\n| 时间 | 门 | 结果 | 缺项 |\n|---|---|---|---|\n"; }
	fs.mkdirSync(workspace, { recursive: true });
	fs.writeFileSync(log, head + line);
}

//#region operation state（目标契约 / 中断恢复的文件契约）

const STATE_FILE = "operation-state.json";

/** 读工作区运行状态；不存在返回 null（纯函数，导出供 route-boost/sec-enforce/测试复用）。 */
export function readOperationState(fsys, workspace) {
	try {
		const raw = fsys.readFileSync(path.join(workspace, STATE_FILE), "utf8");
		const st = JSON.parse(raw);
		if (st && typeof st === "object" && Array.isArray(st.criteria)) return st;
	} catch { /* 缺失或损坏都按无状态处理 */ }
	return null;
}

/** 原子写：同目录临时文件 + rename 覆盖。
 *  为什么不用 writeFileSync 直写：并发读（另一线程/进程）可能读到写到一半的残缺 JSON，
 *  readOperationState 会把它当"无状态"整个丢掉。rename 在同类文件系统上是原子的。 */
export function writeStateAtomic(fsys, workspace, st) {
	fsys.mkdirSync(workspace, { recursive: true });
	const file = path.join(workspace, STATE_FILE);
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	fsys.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
	fsys.renameSync(tmp, file);
}

/** 跨进程排他锁：以 "wx"（存在即失败）创建锁文件；带超时回收，避免进程崩溃留下死锁。
 *  多路并行探索时，多个 Solver 会同时改同一份 operation-state.json。 */
export function withStateLock(fsys, workspace, fn, { waitMs = 5000, staleMs = 15000 } = {}) {
	fsys.mkdirSync(workspace, { recursive: true });
	const lock = path.join(workspace, STATE_FILE + ".lock");
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			fsys.writeFileSync(lock, String(process.pid), { flag: "wx" });
			break;
		} catch {
			// 持锁者可能已崩溃：超过 staleMs 的锁直接回收
			try {
				const mtime = fsys.statSync(lock).mtimeMs;
				if (Date.now() - mtime > staleMs) {
					try { fsys.unlinkSync(lock); } catch { /* 已被别人回收 */ }
					continue;
				}
			} catch { /* 锁刚被释放，立刻重试 */ }
			if (Date.now() > deadline) throw new Error("operation-state.json 锁等待超时（另一写入者未释放）");
		}
	}
	try {
		return fn();
	} finally {
		try { fsys.unlinkSync(lock); } catch { /* 已被回收，忽略 */ }
	}
}

/** 加锁执行一次「读 → 改 → 原子写」。mutator 收到当前状态、返回改后的状态；
 *  返回 null 表示"不写"（前置条件不满足）。create 用于状态文件缺失时的骨架。 */
export function mutateStateLocked(fsys, workspace, mutator, { create } = {}) {
	return withStateLock(fsys, workspace, () => {
		let st = readOperationState(fsys, workspace);
		if (st === null) {
			if (typeof create !== "function") return null;
			st = create();
		}
		const next = mutator(st);
		if (next === null || next === undefined) return null;
		next._rev = (Number(st._rev) || 0) + 1;
		next.updated_at = new Date().toISOString();
		writeStateAtomic(fsys, workspace, next);
		return next;
	});
}

/** stage_gate 判定后同步 gates 进度（无契约时也落骨架——恢复盘先于契约也能工作）；失败静默。 */
function syncOperationState(workspace, verdict) {
	try {
		// gates 按门累加：并发判定不同门时，后写者不得覆盖先写者 → 整段进锁
		mutateStateLocked(fs, workspace, (cur) => {
			cur.mode = verdict.mode;
			cur.gates = cur.gates && typeof cur.gates === "object" ? cur.gates : {};
			cur.gates[verdict.stage] = { pass: verdict.pass, at: new Date().toISOString() };
			return cur;
		}, {
			create: () => ({ version: 1, mode: verdict.mode, goal: "", criteria: [], gates: {}, pending: [], created_at: new Date().toISOString() }),
		});
	} catch { /* 状态同步失败不影响门禁判定 */ }
}

const cleanLine = (s, max) => String(s ?? "").trim().slice(0, max);
const parseIds = (s) => String(s ?? "").split(/[,，;\s]+/).map((x) => x.trim()).filter(Boolean);

/** 登记目标契约：criteria 为多行文本，每行一条成功准则（可判定表述）。 */
function setGoal(workspace, goal, criteriaText) {
	const lines = String(criteriaText ?? "").split(/\r?\n/).map((l) => cleanLine(l, 200)).filter(Boolean);
	if (!cleanLine(goal, 500)) throw new Error("goal required（目标一句话）");
	if (lines.length === 0) throw new Error("criteria required（至少一条成功准则，每行一条）");
	if (lines.length > 20) throw new Error("criteria 最多 20 条");
	const st = mutateStateLocked(fs, workspace, (cur) => {
		cur.goal = cleanLine(goal, 500);
		cur.criteria = lines.map((text, i) => ({ id: `g${i + 1}`, text, status: "open", evidence: "" }));
		return cur;
	}, {
		// 骨架必须带 criteria：readOperationState 以 Array.isArray(criteria) 判有效性
		create: () => ({ version: 1, mode: "", goal: "", criteria: [], gates: {}, pending: [], created_at: new Date().toISOString() }),
	});
	return st;
}

/** 收口准则 / 维护待办；返回摘要（verdict=all-met 表示目标契约已全部达成）。 */
function updateProgress(workspace, { met = "", failed = "", reopened = "", pending = "", note = "", intent_done = "", intent_blocked = "", intent_dropped = "" }) {
	// 收口是并发热点（多路各自收口自己的准则/意图）：整段读改写进锁
	const st = mutateStateLocked(fs, workspace, (cur) => {
	recoverStaleTasks(cur);
	const byId = new Map(cur.criteria.map((c) => [c.id, c]));
	const unknown = [];
	for (const [list, status] of [[met, "met"], [failed, "failed"], [reopened, "open"]]) {
		for (const id of parseIds(list)) {
			const c = byId.get(id);
			if (c === undefined) unknown.push(id);
			else c.status = status;
		}
	}
	if (unknown.length) throw new Error(`未知准则 id：${unknown.join(", ")}（有效：${[...byId.keys()].join(", ") || "无"}）`);
	// 意图收口：done=有产出收口 / blocked=受阻终态 / dropped=放弃（blocked/dropped 须在 note 说明原因）
	const intents = normalizeIntents(cur);
	if (intents.length > 0 || intent_done || intent_blocked || intent_dropped) {
		const byIntent = new Map(intents.map((i) => [i.id, i]));
		const unknownIntents = [];
		for (const [list, status] of [[intent_done, "done"], [intent_blocked, "blocked"], [intent_dropped, "dropped"]]) {
			for (const id of parseIds(list)) {
				const i = byIntent.get(id);
				if (i === undefined) unknownIntents.push(id);
				else {
					i.status = status;
					i.closed_at = new Date().toISOString();
					if (i.task) {
						const task = taskOf(i);
						i.task = { ...task, state: status === "done" ? "succeeded" : status === "blocked" ? "failed" : "cancelled", updatedAt: i.closed_at, heartbeatAt: i.closed_at };
					}
				}
			}
		}
		if (unknownIntents.length) throw new Error(`未知意图 id：${unknownIntents.join(", ")}（有效：${[...byIntent.keys()].join(", ") || "无"}）`);
		if ((intent_blocked || intent_dropped) && !note) throw new Error("blocked/dropped 收口须在 note 说明原因（受阻依据/放弃理由——终态可追溯）");
		cur.intents = intents;
	}
	if (pending !== "") cur.pending = pending.split(/\r?\n/).map((l) => cleanLine(l, 200)).filter(Boolean);
	if (note) cur.note = cleanLine(note, 500);
	return cur;
	});
	if (st === null) throw new Error("operation-state.json 不存在——先 operation_goal 登记目标契约");
	const openIds = st.criteria.filter((c) => c.status !== "met" && c.status !== "failed").map((c) => c.id);
	const metCount = st.criteria.filter((c) => c.status === "met").length;
	const failedCount = st.criteria.filter((c) => c.status === "failed").length;
	return { goal: st.goal, total: st.criteria.length, met: metCount, failed: failedCount, open: openIds.length, openIds, pending: st.pending, intents: intentSummary(st), verdict: openIds.length === 0 ? "all-met" : "open-remaining" };
}

//#region 覆盖度台账（scope/分子登记 + 报告门算术对账）

/** 每模式的报告门（与 sec-enforce REPORT_GATE 对齐）——覆盖度对账挂在这些门的判定里。 */
const REPORT_GATES = { pentest: "P3", "code-audit": "A3", "binary-analysis": "B2", "attack-defense": "report", "av-evasion": "V4", "incident-response": "I5", "cloud-security": "C7", "ctf-solver": "flag" };

/** 范围台账归一：scope 数组（每项 {id,label}）。 */
function normalizeScope(st) {
	if (!Array.isArray(st?.scope)) return [];
	return st.scope.filter((s) => s && typeof s === "object" && typeof s.id === "string" && s.id).map((s) => ({ id: s.id, label: String(s.label ?? s.id).slice(0, 200) }));
}
function normalizeTested(st) {
	if (!Array.isArray(st?.tested)) return [];
	return st.tested.filter((t) => t && typeof t === "object" && typeof t.id === "string" && t.id).map((t) => ({ id: t.id, evidence: String(t.evidence ?? "").slice(0, 300), at: t.at }));
}

/** 登记范围台账（分母）：items 每行一项（「标签」或「id: 标签」），重登记整表替换。
 *  scope 一经登记，报告门激活算术对账——报告/覆盖矩阵必须声明与台账一致的「覆盖：M/N」。 */
export function setScope(workspace, itemsText) {
	const lines = String(itemsText ?? "").split(/\r?\n/).map((l) => cleanLine(l, 200)).filter(Boolean);
	if (lines.length === 0) throw new Error("items required（至少一项，每行一条：标签 或 id: 标签）");
	if (lines.length > 200) throw new Error("scope 最多 200 项");
	const seen = new Set();
	const items = lines.map((line, i) => {
		const m = /^([A-Za-z0-9_-]{1,16}):\s*(.+)$/.exec(line);
		const id = m ? m[1] : `s${i + 1}`;
		if (seen.has(id)) throw new Error(`scope id 重复：${id}`);
		seen.add(id);
		return { id, label: (m ? m[2] : line).slice(0, 200) };
	});
	const st = mutateStateLocked(fs, workspace, (cur) => {
		cur.scope = items;
		if (!Array.isArray(cur.tested)) cur.tested = [];
		// 重登记范围后，越界的 tested 行剔除（id 不在新 scope 内的丢弃）
		cur.tested = normalizeTested(cur).filter((t) => seen.has(t.id));
		return cur;
	});
	if (st === null) throw new Error("operation-state.json 不存在——先 operation_goal 登记目标契约，再 operation_scope 登记范围");
	return scopeSummary(st);
}

/** 标记已测（分子）：ids 来自 scope，evidence 必填（证据指位）。幂等（重复标记刷新证据与时间）。 */
export function markTested(workspace, ids, evidence) {
	const list = parseIds(ids);
	if (list.length === 0) throw new Error("tested ids required");
	if (!cleanLine(evidence, 300)) throw new Error("evidence required（tested 必须带证据指位——evidence 编号/矩阵行/输出文件）");
	// 整段「读—改—写」进锁：多路并行各标自己的覆盖时，后写者不得整体覆盖先写者
	const st = mutateStateLocked(fs, workspace, (cur) => {
		const scope = normalizeScope(cur);
		if (scope.length === 0) throw new Error("scope 未登记——先 operation_scope 登记范围分母");
		const known = new Set(scope.map((s) => s.id));
		const unknown = list.filter((id) => !known.has(id));
		if (unknown.length) throw new Error(`未知 scope id：${unknown.join(", ")}（有效：${[...known].join(", ")}）`);
		const tested = normalizeTested(cur).filter((t) => !list.includes(t.id));
		const at = new Date().toISOString();
		for (const id of list) tested.push({ id, evidence: cleanLine(evidence, 300), at });
		cur.tested = tested;
		return cur;
	});
	if (st === null) throw new Error("operation-state.json 不存在——先 operation_goal 登记目标契约");
	return scopeSummary(st);
}

/** 覆盖度摘要（tested 只计 scope 内 id）。 */
function scopeSummary(st) {
	const scope = normalizeScope(st);
	const tested = normalizeTested(st);
	const testedIds = new Set(tested.map((t) => t.id));
	const untestedIds = scope.filter((s) => !testedIds.has(s.id)).map((s) => s.id);
	return { scope: scope.length, tested: tested.filter((t) => testedIds.has(t.id)).length, untested: untestedIds.length, untestedIds };
}

/** 报告门覆盖度对账（纯函数，fsm 可注入供测试）。scope 未登记返回 null（对账不激活）。
 *  规则：报告/矩阵文件须声明「覆盖：M/N」（或 coverage: M/N），且 M/N 必须等于台账实测——
 *  部分覆盖照实声明可过，虚报/漏报拦。 */
export function coverageCheck(fsm, workspace, reportFile) {
	let st;
	try {
		const raw = fsm.readFileSync(path.join(workspace, STATE_FILE), "utf8");
		st = JSON.parse(raw);
	} catch { return null; }
	const scope = normalizeScope(st);
	if (scope.length === 0) return null;
	const summary = scopeSummary(st);
	let text = "";
	try { text = fsm.readFileSync(reportFile, "utf8"); } catch {
		return { ok: false, detail: `覆盖度对账：报告文件不可读（${path.basename(reportFile)}）` };
	}
	const m = /覆盖度?\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)|coverage\s*[：:]\s*(\d+)\s*[/／]\s*(\d+)/i.exec(text);
	if (!m) {
		return { ok: false, detail: `覆盖度对账：scope 已登记 ${summary.scope} 项（已测 ${summary.tested}），报告须声明「覆盖：${summary.tested}/${summary.scope}」——部分覆盖照实声明可过（未测项 ${summary.untestedIds.join(", ") || "无"} 须列入未覆盖清单），虚报或漏报拦截` };
	}
	const declaredTested = Number(m[1] ?? m[3]);
	const declaredTotal = Number(m[2] ?? m[4]);
	if (declaredTested !== summary.tested || declaredTotal !== summary.scope) {
		return { ok: false, detail: `覆盖度对账：报告声明 ${declaredTested}/${declaredTotal} 与台账不符——程序实测：已测 ${summary.tested} / 共 ${summary.scope}（未测：${summary.untestedIds.join(", ") || "无"}）。先 operation_progress tested 补登记，或修正报告声明` };
	}
	return { ok: true, detail: `覆盖度对账通过：${summary.tested}/${summary.scope}${summary.untested > 0 ? `（部分覆盖，未测 ${summary.untested} 项照实声明）` : ""}` };
}

//#endregion

//#region 意图台账（八专业模式）：方向登记带锚 + 收口联动

export const ANCHOR_KINDS = ["boot", "criterion", "scope", "finding", "chain"];
export const TASK_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"];
const TASK_STALE_MS = 30 * 60 * 1000;

/** 意图台账归一：intents 数组。status: open / done / blocked / dropped。 */
function normalizeIntents(st) {
	if (!Array.isArray(st?.intents)) return [];
	return st.intents.filter((i) => i && typeof i === "object" && typeof i.id === "string" && i.id);
}

function taskOf(intent) {
	const t = intent?.task;
	if (!t || typeof t !== "object") return null;
	return {
		state: TASK_STATES.includes(t.state) ? t.state : "queued",
		owner: cleanLine(t.owner, 80),
		attempts: Math.max(0, Number(t.attempts) || 0),
		maxAttempts: Math.max(1, Math.min(20, Number(t.maxAttempts) || 1)),
		progress: Math.max(0, Math.min(100, Number(t.progress) || 0)),
		error: cleanLine(t.error, 500),
		result: cleanLine(t.result, 1000),
		artifacts: Array.isArray(t.artifacts) ? t.artifacts.map((x) => cleanLine(x, 300)).filter(Boolean).slice(0, 20) : [],
		// 冲突记录（P1-9）：终态之后又收到**不同**结果的次数与摘要。
		// 只记不覆盖——台账保留第一个终态，矛盾本身进 attention 让人复核。
		conflicts: Array.isArray(t.conflicts)
			? t.conflicts.slice(-5).map((c) => ({
				at: cleanLine(c?.at, 40),
				from: cleanLine(c?.from, 20),
				to: cleanLine(c?.to, 20),
				detail: cleanLine(c?.detail, 300),
			})).filter((c) => c.from || c.to)
			: [],
		startedAt: t.startedAt || "",
		updatedAt: t.updatedAt || "",
		heartbeatAt: t.heartbeatAt || "",
	};
}

/** Mark stale running tasks as interrupted while holding the state lock. */
function recoverStaleTasks(st, now = Date.now()) {
	const intents = normalizeIntents(st);
	let recovered = 0;
	for (const intent of intents) {
		const task = taskOf(intent);
		if (!task || task.state !== "running") continue;
		const last = Date.parse(task.heartbeatAt || task.updatedAt || "");
		if (Number.isFinite(last) && now - last <= TASK_STALE_MS) continue;
		intent.task = { ...task, state: "interrupted", error: task.error || "heartbeat expired", updatedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() };
		recovered += 1;
	}
	if (recovered > 0) st.intents = intents;
	return recovered;
}

/** Derive task counts for status/conclusion checks. */
function taskSummary(st) {
	const intents = normalizeIntents(st);
	const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
	for (const intent of intents) {
		const task = taskOf(intent);
		if (task) counts[task.state] += 1;
	}
	return counts;
}

/** 锚点校验（纯函数，跨库解析器注入供测试）。返回 "" = 通过；非空 = 拒绝理由。
 *  语义：意图只能锚在「已确立的证据」上——criterion/scope 查本文件，finding/chain 查
 *  当前会话的成果库/链路库（意图登记会话=发现登记会话），boot=开局/顶层全新方向豁免。 */
export function validateAnchor(st, { kind, ref }, resolvers = {}, sessionId = "", mode = "") {
	const k = ANCHOR_KINDS.includes(kind) ? kind : "";
	if (!k) return `anchor_kind 非法：${kind}（合法：${ANCHOR_KINDS.join(" / ")}——boot=开局豁免、criterion=准则 id、scope=范围 id、finding=成果 id、chain=链路节点 id）`;
	if (k === "boot") return "";
	const r = String(ref ?? "").trim();
	if (!r) return `anchor_ref 必填（${k} 锚必须带具体 id；顶层全新方向才用 boot 豁免）`;
	if (k === "criterion") {
		const ids = new Set((Array.isArray(st?.criteria) ? st.criteria : []).map((c) => c?.id).filter(Boolean));
		return ids.has(r) ? "" : `准则 id 不存在：${r}（有效：${[...ids].join(", ") || "无——先 operation_goal 登记"}）`;
	}
	if (k === "scope") {
		const ids = new Set(normalizeScope(st).map((s) => s.id));
		return ids.has(r) ? "" : `scope id 不存在：${r}（有效：${[...ids].join(", ") || "无——先 operation_scope 登记"}）`;
	}
	if (k === "finding") {
		if (typeof resolvers.findingExists === "function") {
			try {
				if (resolvers.findingExists(sessionId, r)) return "";
				return `finding 不存在（当前会话）：${r}——成果 id 形如 pentest-3（本会话 redteam_finding_register 登记；跨会话成果不可锚，改用 chain 或材料路径）`;
			} catch {
				return ""; // 解析器故障降级放行（不 brick 意图登记）
			}
		}
		return /^[a-z][a-z0-9-]*-\d+$/.test(r) ? "" : `finding id 形如 pentest-3（模式-序号）：${r} 格式不符`;
	}
	if (k === "chain") {
		if (typeof resolvers.chainExists === "function") {
			try {
				if (resolvers.chainExists(sessionId, mode, r)) return "";
				return `链路节点不存在（当前会话）：${r}——链路节点由 redteam_chain_node 登记，查「链路」标签页或 redteam_chain_list`;
			} catch {
				return ""; // 同上降级
			}
		}
		return /^[\w-]{1,64}$/.test(r) ? "" : `链路节点 id 格式不符：${r}`;
	}
	return "";
}

/** 登记意图（方向带锚）。返回 {total, open}；校验失败 throw。 */
export function registerIntent(workspace, { summary, anchorKind, anchorRef, note = "", sessionId = "", mode = "", owner = "", maxAttempts = 1 }, resolvers = {}) {
	const s = cleanLine(summary, 200);
	if (!s) throw new Error("summary required（一句话方向，≤200 字符）");
	const bad = validateAnchor(readOperationState(fs, workspace), { kind: anchorKind, ref: anchorRef }, resolvers, sessionId, mode);
	if (bad) throw new Error(bad);
	// id 按总数递增、且多路会同时登记 → 必须在锁内取号，否则会出现重复 id
	const st = mutateStateLocked(fs, workspace, (cur) => {
		const intents = normalizeIntents(cur);
		const id = `i${intents.length + 1}`;
		const now = new Date().toISOString();
		const item = {
			id,
			summary: s,
			anchor: { kind: anchorKind, ref: cleanLine(anchorRef, 80) },
			status: "open",
			note: cleanLine(note, 300),
			sessionId: cleanLine(sessionId, 120),
			mode: cleanLine(mode, 40),
			created_at: now,
		};
		const hasTask = cleanLine(owner, 80) || Number(maxAttempts) > 1;
		if (hasTask) {
			item.task = {
				state: "queued",
				owner: cleanLine(owner, 80),
				attempts: 0,
				maxAttempts: Math.max(1, Math.min(20, Number(maxAttempts) || 1)),
				progress: 0,
				error: "",
				result: "",
				artifacts: [],
				startedAt: "",
				updatedAt: now,
				heartbeatAt: now,
			};
		}
		intents.push(item);
		cur.intents = intents;
		return cur;
	});
	if (st === null) throw new Error("operation-state.json 不存在——先 operation_goal 登记目标契约");
	return intentSummary(st);
}

/** 意图摘要。 */
export function intentSummary(st) {
	const intents = normalizeIntents(st);
	const openIds = intents.filter((i) => i.status === "open").map((i) => i.id);
	return { total: intents.length, open: openIds.length, openIds, tasks: taskSummary(st) };
}

/** Transition the execution state of an intent task. */
export function taskTransition(workspace, { id, action, owner = "", progress, result = "", error = "", artifacts, note = "" }) {
	const taskId = cleanLine(id, 40);
	const act = cleanLine(action, 20);
	if (!taskId) throw new Error("id required");
	if (!["start", "heartbeat", "progress", "succeed", "fail", "cancel", "retry", "interrupt", "update"].includes(act)) {
		throw new Error(`unknown task action: ${act}`);
	}
	let conflictFlag = false;
	const st = mutateStateLocked(fs, workspace, (cur) => {
		recoverStaleTasks(cur);
		const intents = normalizeIntents(cur);
		const intent = intents.find((item) => item.id === taskId);
		if (!intent) throw new Error(`未知意图 id：${taskId}`);
		if (!intent.task) throw new Error(`意图 ${taskId} 未登记任务执行层`);
		const current = taskOf(intent);
		const now = new Date().toISOString();
		const next = { ...current, updatedAt: now };
		const closed = new Set(["succeeded", "failed", "cancelled"]);
		const running = new Set(["running"]);

		if (act === "start") {
			if (current.state !== "queued") throw new Error(`任务 ${taskId} 状态 ${current.state} 不能 start`);
			next.attempts = current.attempts + 1;
			if (next.attempts > current.maxAttempts) throw new Error(`任务 ${taskId} 尝试次数已达上限 ${current.maxAttempts}`);
			next.state = "running";
			next.startedAt = now;
			next.heartbeatAt = now;
			next.error = "";
		} else if (act === "heartbeat") {
			if (!running.has(current.state)) throw new Error(`任务 ${taskId} 状态 ${current.state} 不能 heartbeat`);
			next.heartbeatAt = now;
		} else if (act === "progress") {
			if (!running.has(current.state)) throw new Error(`任务 ${taskId} 状态 ${current.state} 不能 progress`);
			if (progress !== undefined) next.progress = Math.max(0, Math.min(100, Number(progress) || 0));
			next.heartbeatAt = now;
		} else if (act === "succeed" || act === "fail") {
			const wanted = act === "succeed" ? "succeeded" : "failed";
			if (closed.has(current.state)) {
				// 终态之后又收到结果：同结果算幂等重放（不改账）；不同结果只记冲突，不覆盖。
				const same = current.state === wanted
					&& (act === "succeed" ? cleanLine(result, 1000) === current.result : cleanLine(error, 500) === current.error);
				if (same) return cur; // 幂等重放：连 updatedAt 都不动
				conflictFlag = true;
				next.conflicts = [
					...(current.conflicts || []),
					{
						at: now,
						from: current.state,
						to: wanted,
						detail: act === "succeed" ? cleanLine(result, 300) : cleanLine(error, 300),
					},
				].slice(-5);
				intent.task = next;
				cur.intents = intents;
				return cur;
			}
		}
		if (act === "succeed") {
			if (!running.has(current.state) && current.state !== "queued") throw new Error(`任务 ${taskId} 状态 ${current.state} 不能 succeed`);
			next.state = "succeeded";
			next.progress = 100;
			next.result = cleanLine(result, 1000);
			next.heartbeatAt = now;
			if (Array.isArray(artifacts)) next.artifacts = artifacts.map((x) => cleanLine(x, 300)).filter(Boolean).slice(0, 20);
		} else if (act === "fail") {
			if (!running.has(current.state) && current.state !== "queued") throw new Error(`任务 ${taskId} 状态 ${current.state} 不能 fail`);
			next.state = "failed";
			next.error = cleanLine(error, 500);
			next.heartbeatAt = now;
		} else if (act === "cancel") {
			if (closed.has(current.state)) throw new Error(`任务 ${taskId} 已是终态 ${current.state}`);
			next.state = "cancelled";
			next.error = cleanLine(error || note, 500);
			next.heartbeatAt = now;
		} else if (act === "retry") {
			if (!["failed", "interrupted", "cancelled"].includes(current.state)) throw new Error(`任务 ${taskId} 状态 ${current.state} 不能 retry`);
			if (current.attempts >= current.maxAttempts) throw new Error(`任务 ${taskId} 尝试次数已达上限 ${current.maxAttempts}`);
			next.state = "queued";
			next.error = cleanLine(error || current.error, 500);
			next.heartbeatAt = now;
		} else if (act === "interrupt") {
			if (!running.has(current.state)) throw new Error(`任务 ${taskId} 状态 ${current.state} 不能 interrupt`);
			next.state = "interrupted";
			next.error = cleanLine(error || "manual interrupt", 500);
			next.heartbeatAt = now;
		} else if (act === "update") {
			if (owner) next.owner = cleanLine(owner, 80);
			if (progress !== undefined && running.has(current.state)) next.progress = Math.max(0, Math.min(100, Number(progress) || 0));
			if (result) next.result = cleanLine(result, 1000);
			if (error) next.error = cleanLine(error, 500);
			if (Array.isArray(artifacts)) next.artifacts = artifacts.map((x) => cleanLine(x, 300)).filter(Boolean).slice(0, 20);
			next.heartbeatAt = now;
		}
		intent.task = next;
		cur.intents = intents;
		return cur;
	});
	if (st === null) throw new Error("operation-state.json 不存在——先 operation_goal 登记目标契约");
	const intent = normalizeIntents(st).find((item) => item.id === taskId);
	return { id: taskId, task: taskOf(intent), summary: intentSummary(st), ...(conflictFlag ? { conflict: true } : {}) };
}

/** Atomically claim the oldest queued task in a workspace. Used by sibling
 * agents that share one project state and must not execute the same task twice. */
export function taskClaim(workspace, { owner = "" } = {}) {
	const claimant = cleanLine(owner, 80);
	let claimedId = "";
	const st = mutateStateLocked(fs, workspace, (cur) => {
		recoverStaleTasks(cur);
		const intents = normalizeIntents(cur);
		const candidates = intents
			.filter((intent) => {
				if (intent.status !== "open" || !intent.task || intent.task.state !== "queued") return false;
				if (!claimant) return true;
				return !cleanLine(intent.task.owner, 80) || ownerMatches(intent.task.owner, new Set([claimant]));
			})
			.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
		if (candidates.length === 0) throw new Error("没有可领取的 queued 任务");
		const intent = candidates[0];
		const current = taskOf(intent);
		if (current.attempts >= current.maxAttempts) throw new Error(`任务 ${intent.id} 尝试次数已达上限 ${current.maxAttempts}`);
		const now = new Date().toISOString();
		claimedId = intent.id;
		intent.task = {
			...current,
			state: "running",
			owner: claimant || current.owner,
			attempts: current.attempts + 1,
			startedAt: now,
			updatedAt: now,
			heartbeatAt: now,
			error: "",
		};
		cur.intents = intents;
		return cur;
	});
	if (st === null) throw new Error("operation-state.json 不存在——先 operation_goal 登记目标契约");
	const intent = normalizeIntents(st).find((item) => item.id === claimedId);
	return { id: claimedId, task: taskOf(intent), summary: intentSummary(st) };
}

const TASK_TOOL_SUFFIXES = ["_scan", "_probe", "_fuzz", "_audit", "_run", "_tool"];

/** Tool-name aliases used only for automatic intent-task binding. */
export function taskToolAliases(toolName) {
	const raw = cleanLine(toolName, 80).toLowerCase();
	if (!raw) return [];
	const names = new Set([raw, raw.replace(/-/g, "_")]);
	for (const value of [...names]) {
		if (value.startsWith("subagent_")) {
			names.add(value.slice("subagent_".length));
			// 生命周期事件（subagent/start|end）只带 provider，模型登记 owner 时常用
			// 通用名 `subagent`（工具名就是 subagent）。不补这条别名，事件侧永远匹配不上。
			names.add("subagent");
		}
		for (const suffix of TASK_TOOL_SUFFIXES) {
			if (value.endsWith(suffix) && value.length > suffix.length) names.add(value.slice(0, -suffix.length));
		}
	}
	return [...names].filter(Boolean);
}

function ownerMatches(owner, aliases) {
	const value = cleanLine(owner, 80).toLowerCase().replace(/-/g, "_");
	if (!value) return false;
	return [...aliases].some((alias) => {
		const candidate = String(alias).toLowerCase().replace(/-/g, "_");
		return value === candidate || value.startsWith(candidate + "_") || candidate.startsWith(value + "_");
	});
}

/**
 * Find the single open, queued task owned by a tool without making the model call
 * operation_task at both ends. Session-scoped intents must match when both sides
 * carry a session id; owner matching is deliberately conservative and excludes
 * one generic fallback when several candidates exist.
 */
export function autoTaskForTool(st, { sessionId = "", toolName = "", states = ["queued"] } = {}) {
	const wanted = new Set(taskToolAliases(toolName));
	if (wanted.size === 0) return null;
	const sid = cleanLine(sessionId, 120);
	const wantedStates = new Set((Array.isArray(states) && states.length ? states : ["queued"]).map((x) => cleanLine(x, 20)));
	const scored = [];
	for (const intent of normalizeIntents(st)) {
		if (intent.status !== "open") continue;
		const task = taskOf(intent);
		if (!task || !wantedStates.has(task.state)) continue;
		if (sid && intent.sessionId && String(intent.sessionId) !== sid) continue;
		const owner = cleanLine(task.owner, 80).toLowerCase().replace(/-/g, "_");
		if (!owner) continue;
		let score = -1;
		if (owner === cleanLine(toolName, 80).toLowerCase()) score = 0;
		else if (wanted.has(owner)) score = 1;
		else if (ownerMatches(owner, wanted)) score = 2;
		if (score >= 0) scored.push({ intent, score });
	}
	if (scored.length === 0) return null;
	scored.sort((a, b) => a.score - b.score || String(a.intent.created_at).localeCompare(String(b.intent.created_at)));
	if (scored.length > 1 && scored[0].score === scored[1].score) return null;
	return scored[0].intent;
}

/** Start the queued task owned by a tool; returns null when no unambiguous binding exists. */
export function startTaskForTool(workspace, { sessionId = "", toolName = "" } = {}) {
	const intent = autoTaskForTool(readOperationState(fs, workspace), { sessionId, toolName });
	if (!intent) return null;
	return taskTransition(workspace, { id: intent.id, action: "start" });
}

/** Close a task started by startTaskForTool according to the tool's own result. */
export function finishTaskForTool(workspace, { id, ok = true, result = "", error = "", artifacts } = {}) {
	const taskId = cleanLine(id, 40);
	if (!taskId) return null;
	return taskTransition(workspace, {
		id: taskId,
		action: ok ? "succeed" : "fail",
		result,
		error: error || (!ok ? "tool failed" : ""),
		artifacts,
	});
}

/**
 * Execution-body wrapper: one call at the tool boundary performs
 * queued -> running -> succeeded/failed. Tracking is best-effort and never
 * changes the wrapped tool's value or throw behavior.
 */
export async function runTrackedTask(workspace, { sessionId = "", toolName = "" } = {}, run) {
	let taskId = "";
	let trackingError = "";
	try {
		const started = startTaskForTool(workspace, { sessionId, toolName });
		taskId = started?.id ?? "";
	} catch (error) {
		trackingError = error?.message ?? String(error);
	}

	let value;
	try {
		value = await run();
	} catch (error) {
		if (taskId) {
			try { finishTaskForTool(workspace, { id: taskId, ok: false, error: error?.message ?? String(error) }); }
			catch { /* task bookkeeping never replaces the tool error */ }
		}
		throw error;
	}

	if (taskId) {
		const ok = value?.ok !== false && !value?.error;
		try {
			finishTaskForTool(workspace, {
				id: taskId,
				ok,
				result: ok ? String(value?.summaryText ?? value?.summary ?? "completed") : "",
				error: ok ? "" : String(value?.error ?? "tool failed"),
				artifacts: value?.file ? [value.file] : value?.persisted ? [value.persisted] : [],
			});
		} catch (error) {
			trackingError = error?.message ?? String(error);
		}
	}
	return { value, taskId, trackingError };
}

/** subagent 家族工具名：原生 subagent / subagent_fork + 产品行 subagent_claude_code / subagent_codex。 */
export function isSubagentTool(toolName) {
	return /^subagent(_|$)/.test(cleanLine(toolName, 80).toLowerCase());
}

/**
 * 从工具结果里抽一条可入账的摘要（`tools/result` 的载荷形如
 * `{ content: [{type:'text',text}], isError, value }`）。空白压平、长度封顶，
 * 只做"够主代理认得出发生了什么"的摘要，正文仍在会话里。
 */
export function summarizeToolResult(result, max = 400) {
	const parts = [];
	const value = result?.value;
	if (typeof value === "string" && value.trim() !== "") parts.push(value);
	const content = Array.isArray(result?.content) ? result.content : [];
	for (const piece of content) {
		if (typeof piece === "string") parts.push(piece);
		else if (piece && typeof piece.text === "string") parts.push(piece.text);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, Math.max(40, Number(max) || 400));
}

/**
 * 子代理生命周期 → 台账任务（P1-9「子代理结果回收」）。
 *
 * 为什么不用 `tools/result`：原生 `subagent` 是**异步派发**——工具结果是
 * `started subagent <id>`（派发确认），真正跑完是 `subagent/end`。
 * 实测（真宿主 mock 子代理）：拿 tools/result 收口会把任务在派发瞬间标 succeeded，
 * 结果摘要只有"started subagent …"，等于假成功。所以按宿主的两条生命周期事件接：
 *   `subagent/start` → 唯一的 queued 任务转 running（顺手挡住重复认领）
 *   `subagent/end`   → completed→succeeded / error→failed / aborted→interrupted
 *
 * 绑定沿用保守规则：同 owner 别名 + 同 session，且**唯一**才动；多候选一律不动。
 */
export function subagentOwnerAlias(provider) {
	const name = cleanLine(provider, 40).replace(/-/g, "_");
	return name ? `subagent_${name}` : "subagent";
}

/** 子代理起跑：把唯一匹配的 queued 任务转 running（没有台账/候选不唯一时返回 null）。 */
export function startSubagentTask(workspace, { sessionId = "", provider = "" } = {}) {
	try {
		return startTaskForTool(workspace, { sessionId, toolName: subagentOwnerAlias(provider) });
	} catch {
		return null;
	}
}

/**
 * 子代理结束：按 stopReason 收口（completed/error/aborted）。
 * 已经不在 running/queued 的任务不动（模型可能自己收过了）。
 */
export function finishSubagentTask(workspace, { sessionId = "", provider = "", stopReason = "completed", summary = "", taskId = "" } = {}) {
	const toolName = subagentOwnerAlias(provider);
	const text = cleanLine(summary, 1000);
	let intent = null;
	try {
		const st = readOperationState(fs, workspace);
		if (!st) return null;
		// 精确绑定优先：start 时记下的 runId→taskId（宿主重启后回退到保守匹配）。
		const exact = cleanLine(taskId, 40);
		intent = exact
			? normalizeIntents(st).find((item) => item.id === exact)
			: (autoTaskForTool(st, { sessionId, toolName, states: ["running"] })
				?? autoTaskForTool(st, { sessionId, toolName, states: ["queued"] }));
	} catch {
		return null;
	}
	if (!intent) return null;
	const id = intent.id;
	const current = taskOf(intent);
	try {
		// 没经过 start（例如宿主没发 start 事件）时先补 running，让 attempts 与时间线完整
		if (current.state === "queued") taskTransition(workspace, { id, action: "start" });
		if (stopReason === "completed") {
			return finishTaskForTool(workspace, { id, ok: true, result: text || "subagent 已完成（无输出）" });
		}
		if (stopReason === "aborted") {
			// 还在跑 → interrupted（可 retry）；已经收口了还收到 aborted → 借 fail 分支记冲突，状态不变
			return taskTransition(workspace, current.state === "running"
				? { id, action: "interrupt", error: text || "subagent aborted" }
				: { id, action: "fail", error: text || "subagent aborted" });
		}
		return finishTaskForTool(workspace, { id, ok: false, error: text || `subagent 失败（${cleanLine(stopReason, 40) || "unknown"}）` });
	} catch {
		return null;
	}
}

/**
 * **结束条件判定**（P1-2「结束条件外置」的系统侧判据）。
 *
 * 为什么要这个（竞品调研 BreachWeave/StrikeAgent 的核心纪律）：
 * 「任务何时结束」不交给模型主观判断 —— 长任务里模型最容易的退化就是**提前宣布收工**：
 * 只跑完最顺的那条路就写总结，把没结论的准则、没收口的方向留在半路。
 * 本函数把「能不能收工」变成**可计算的事实**，`operation_conclude` 工具据此
 * 决定是否 `concludeTurn()`（宿主级收尾）—— 模型只能**申请**，判定权在系统。
 *
 * 判据（只拦「没结论」，不拦「失败」）：
 *   · 准则 status === "open" → 拦（还没结论）。met / failed 都算已收口 ——
 *     验证后确证做不到也是有效终态，如实写报告即可；卡住它等于逼模型造假。
 *   · 意图 status === "open" → 拦（方向没交代）。done / blocked / dropped 都算终态。
 *   · 没有台账（未 operation_goal）→ 放行：那是普通会话，本来就不该被闸门管。
 *
 * @param {object|null} st 已解析的 operation-state.json（null = 无台账）
 * @returns {{canConclude: boolean, reason: string, blockers: Array<{kind: string, id: string, text: string}>, criteria: {total: number, open: number}, intents: {total: number, open: number}}}
 */
export function conclusionVerdict(st) {
	if (st === null || st === undefined) {
		return {
			canConclude: true,
			reason: "本会话未登记目标契约（无 operation-state.json）——无需系统判定",
			blockers: [],
			criteria: { total: 0, open: 0 },
			intents: { total: 0, open: 0 },
			tasks: taskSummary(null),
		};
	}
	const criteria = Array.isArray(st.criteria) ? st.criteria : [];
	const openCriteria = criteria.filter((c) => c && c.status !== "met" && c.status !== "failed");
	const intents = normalizeIntents(st);
	const openIntents = intents.filter((i) => i.status === "open");
	const blockers = [
		...openCriteria.map((c) => ({ kind: "criterion", id: String(c.id ?? ""), text: cleanLine(c.text, 120) })),
		...openIntents.map((i) => ({ kind: "intent", id: i.id, text: cleanLine(i.summary, 120) })),
	];
	const canConclude = blockers.length === 0;
	// reason 直接告诉模型「下一步该做什么」，而不是只说"不行"
	let reason;
	if (canConclude) {
		reason = criteria.length === 0
			? "目标契约无准则（异常但可收尾）——直接收尾"
			: `全部收口：准则 ${criteria.length}/${criteria.length}（met 或 failed 均有结论），意图 ${intents.length} 条无未收口`;
	} else {
		const parts = [];
		if (openCriteria.length) parts.push(`${openCriteria.length} 条准则无结论（${openCriteria.map((c) => c.id).join(",")}）——operation_progress 收口为 met 或 failed`);
		if (openIntents.length) parts.push(`${openIntents.length} 条意图未收口（${openIntents.map((i) => i.id).join(",")}）——operation_progress intent_done/intent_blocked/intent_dropped`);
		reason = "不可收尾：" + parts.join("；");
	}
	return {
		canConclude,
		reason,
		blockers,
		criteria: { total: criteria.length, open: openCriteria.length },
		intents: { total: intents.length, open: openIntents.length },
		tasks: taskSummary(st),
	};
}

/** 跨库锚点解析器（默认实现：动态 import 同 bundle 兄弟插件 store；不可达的键缺省——
 *  validateAnchor 对缺省解析器走格式校验降级，不 brick 意图登记）。 */
async function defaultResolvers() {
	const out = {};
	try {
		const { openStore: openResults } = await import("@dsh-external/dsh-redteam-results/store");
		const results = openResults(path.join(DSH_HOME, "redteam-results", "results.db"));
		out.findingExists = (sessionId, id) => {
			try { return Boolean(results.getFinding(sessionId, id)); } catch { return false; }
		};
	} catch { /* 成果库不可达：finding 锚走格式校验降级 */ }
	try {
		const { openStore: openAtlas, listChain } = await import("@dsh-external/dsh-attack-atlas/store");
		const atlas = openAtlas(path.join(DSH_HOME, "attack-atlas", "atlas.db"));
		out.chainExists = (sessionId, mode, id) => {
			try { return listChain(atlas, sessionId, mode).nodes.some((n) => n.id === id); } catch { return false; }
		};
	} catch { /* 图谱库不可达：chain 锚走格式校验降级 */ }
	return out;
}
let resolverCache;
function theResolvers() {
	if (resolverCache === undefined) resolverCache = defaultResolvers().catch(() => ({}));
	return resolverCache;
}

//#endregion

//#region 模式化拆分理论（DECOMPOSITION 注入）——机制骨架统一，理论血肉模式化

/** 拆分理论映射（现行专业模式：渗透测试 / 代码审计 / CTF；历史模式数据保留供扩展参考）。
 *  机制层不写模式分支——理论以数据注入：operation_goal/scope/constraints 的 render
 *  按会话模式带出对应条目，kickoff 提醒（auto-advance）与任务书预拆同源消费。 */
export const DECOMPOSITION = {
	pentest: {
		theory: "作战流程×资产×漏洞类矩阵：被动收集→入口面盘点→验证",
		criteriaGuide: "准则按「每入口资产一条终态 + 漏洞类覆盖格全终态」拆，覆盖矩阵格不落空",
		scopeSemantics: "分母=入口资产面（主机/站点/API/客户端），每行一项资产单元",
		constraintHints: "速率纪律/资金类只读重放/破坏操作禁执行/授权边界",
		example: "①demo 站 Web 面每漏洞类格有终态 ②10.0.0.5 服务面终态 ③高危发现附 PoC 复现"
	},
	"code-audit": {
		theory: "对象形态→triage→模块×sink 矩阵→双链（全量扫描链+深度审计链）",
		criteriaGuide: "准则按「每模块终态 + sink 类覆盖 + 扫描命中对账守恒（扫描器报告数=终态数）」拆",
		scopeSemantics: "分母=模块/路由/文件全集，每行一个审计单元",
		constraintHints: "审计对象只读/semgrep 禁网/不修被审代码",
		example: "①全部 12 条路由每条给终态 ②sink 五类各有覆盖结论 ③扫描命中 100% 对账"
	},
	"binary-analysis": {
		theory: "样本登记→家族指纹分诊→假设台账循环→多视角→IOC",
		criteriaGuide: "准则按「每样本每分析维度终态 + 假设台账全收口（未决不得写成事实）」拆",
		scopeSemantics: "分母=样本集×分析维度，每行一个样本或一个维度面",
		constraintHints: "干净 VM 铁律/样本外传登记/活体处置 SOP",
		example: "①样本 A 静态+动态两维度终态 ②假设台账全部 confirmed/dismissed ③IOC 输出可机读"
	},
	"attack-defense": {
		theory: "五阶段编排（侦察→突破→横向→持久化→报告），每阶段只基于上一阶段已验证结果",
		criteriaGuide: "准则按「每阶段产物过门 + 链级分布（L1-L5）+ 战果登记」拆",
		scopeSemantics: "分母=授权网段/凭据面/高价值线，每行一个作战面",
		constraintHints: "监测姿态分叉（§0.5 姿态卡）/破坏性步骤默认关/痕迹双轨",
		example: "①外网拿到初始访问 ②横向覆盖授权网段 80% ③链级分布呈报"
	},
	"av-evasion": {
		theory: "配对实验：载荷↔判定引擎矩阵，四类载荷标准时序",
		criteriaGuide: "准则按「每载荷类×引擎终态（过检/被检出附指纹）」拆——配对完整是硬约束",
		scopeSemantics: "分母=载荷类×引擎矩阵（登记制，不自动派生）",
		constraintHints: "授权立场/产物限实验室目录/清痕顺序纪律",
		example: "①CS 载荷过 360 全家桶（附指纹）②四类载荷各至少一引擎终态"
	},
	"incident-response": {
		theory: "证据保全→时间线重建→定性→处置建议→报告（I1-I5 五门）",
		criteriaGuide: "准则按「时间线节点收口 + 五维定损 + IOC 富化」拆",
		scopeSemantics: "分母=主机/时间窗/案件范围，每行一台主机或一个调查面",
		constraintHints: "只读优先/证据四级/先固定后分析",
		example: "①入口点定位附证据 ②完整时间线（含横向路径）③影响范围五维定损"
	},
	"cloud-security": {
		theory: "资产测绘→攻击路径四要素（身份→权限→资源→影响）→场景卡",
		criteriaGuide: "准则按「每条攻击路径验证 + 权限链收口 + 场景卡终态」拆",
		scopeSemantics: "分母=账号/区域/服务面，每行一个云资源或信任面",
		constraintHints: "只读 API 优先/写操作过门/环境还原义务",
		example: "①目标账号权限链收口 ②至少一条路径打通到影响 ③环境还原登记"
	},
	"ctf-solver": {
		theory: "题面登记→模块路由→board/solve 两门→flag 台账",
		criteriaGuide: "准则按「每题终态（已解附平台验证/卡点附原因）」拆",
		scopeSemantics: "分母=题目集（含分值权重），每行一题（登记制，不自动派生）",
		constraintHints: "flag 真实性=平台回显/不猜不撞/爆破限速最后手段",
		example: "①全部题目终态三选一（已解/卡点/放弃附因）②flag 全部平台验证"
	},
	redteam: {
		theory: "任务分类路由→轻重判→任务书（依据锚+模式理论摘要）；总控不设自身准则——消费专业模式 gate-pass 产物",
		criteriaGuide: "（总控不拆准则——路由到专业模式后由其按自身理论登记）",
		scopeSemantics: "（总控不设分母——由接手模式登记）",
		constraintHints: "三边界：不越权 gate 判定/只消费 gate-pass 产物/读盘可见性",
		example: "任务书带依据锚与建议模式的理论摘要行，接手模式照此开工三登记"
	}
};

/** 会话模式解析（工具 execute 用；未知/无模式返回 ""）。 */
function modeOfExec(ctx, exec) {
	const agent = exec?.agent;
	if (!agent) return "";
	let preset = "";
	try { preset = String(ctx.agentPresets?.composedPreset?.(agent.ctx) ?? ""); } catch { /* 组合未就绪 */ }
	if (!DECOMPOSITION[preset]) {
		const header = agent?.session?.header?.agentPreset;
		preset = DECOMPOSITION[header] ? header : "";
	}
	return preset;
}

//#endregion

//#region 约束层（deny/allow 登记与匹配数据面）+ scope 保守派生

export const CONSTRAINT_KINDS = ["deny", "allow"];

/** 约束台账归一：constraints 数组（id c1..、kind deny/allow、text、keywords 匹配词）。 */
export function normalizeConstraints(st) {
	if (!Array.isArray(st?.constraints)) return [];
	return st.constraints
		.filter((c) => c && typeof c === "object" && CONSTRAINT_KINDS.includes(c.kind) && typeof c.text === "string" && c.text.trim())
		.map((c) => ({ id: c.id, kind: c.kind, text: c.text.slice(0, 200), keywords: Array.isArray(c.keywords) ? c.keywords.filter((k) => typeof k === "string" && k).slice(0, 12) : [] }));
}

/** 登记约束（整表替换，同 criteria/scope 语义）。行格式：`deny: 文本` / `allow: 文本`，
 *  可选匹配词 `deny: 文本 :: kw1,kw2`（有匹配词的 deny 条目会接 sec-enforce 确定性拦截：
 *  bash 命令/fetch URL 命中即拦；无匹配词=提示层注入，不拦截）。拿不准 kind 用 deny（保守）。 */
export function setConstraints(workspace, itemsText) {
	const lines = String(itemsText ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) throw new Error("items required（至少一条，每行：deny: 文本 [:: 匹配词]）");
	if (lines.length > 30) throw new Error("约束最多 30 条");
	const seen = new Set();
	const items = lines.map((line, i) => {
		const m = /^(deny|allow)\s*[：:]\s*(.+)$/.exec(line);
		if (!m) throw new Error(`行 ${i + 1} 格式非法：「${line.slice(0, 40)}」——须以 deny: 或 allow: 开头`);
		let text = m[2];
		let keywords = [];
		const kw = /\s*::\s*(.+)$/.exec(text);
		if (kw) {
			keywords = kw[1].split(/[,，]/).map((k) => k.trim()).filter(Boolean).slice(0, 12);
			text = text.slice(0, kw.index).trim();
		}
		const id = `c${i + 1}`;
		if (seen.has(id)) throw new Error(`约束 id 重复：${id}`);
		seen.add(id);
		return { id, kind: m[1], text: text.slice(0, 200), keywords };
	});
	const st = mutateStateLocked(fs, workspace, (cur) => {
		cur.constraints = items;
		return cur;
	});
	if (st === null) throw new Error("operation-state.json 不存在——先 operation_goal 登记目标契约");
	return constraintSummary(st);
}

/** 约束摘要（guard 与信封消费的数据面）。 */
export function constraintSummary(st) {
	const list = normalizeConstraints(st);
	const deny = list.filter((c) => c.kind === "deny");
	return {
		total: list.length,
		deny: deny.length,
		allow: list.length - deny.length,
		denyGuarded: deny.filter((c) => c.keywords.length > 0).length,
		lines: list.map((c) => `${c.kind === "deny" ? "禁" : "允"}：${c.text}${c.keywords.length ? `（匹配词 ${c.keywords.join("/")}）` : ""}`)
	};
}

/** scope 保守派生（纯函数，模式感知）：统一提取器（URL 主机/多标签裸域/IPv4）+ 模式增补
 *  ——audit 加文件路径与路由前缀、binary 加样本哈希、cloud 加 ARN/账号/区域、ad 加 CIDR；
 *  av/ctf/redteam 登记制不派生（返回空）。排除版本号与常见误伤；**不放大到根域**。
 *  只出草稿不落库，模型确认后 operation_scope 登记。 */
export function deriveScopeDraft(texts, mode = "") {
	const raw = Array.isArray(texts) ? texts.join("\n") : String(texts ?? "");
	const hosts = new Set();
	for (const m of raw.matchAll(/https?:\/\/([A-Za-z0-9.-]+)[:/]/gi)) hosts.add(m[1].toLowerCase());
	for (const m of raw.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?:$|[\s。）)，,；;])/gm)) hosts.add(m[1].toLowerCase());
	for (const m of raw.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) {
		const ip = m[1];
		if (ip.split(".").every((o) => Number(o) <= 255)) hosts.add(ip);
	}
	for (const m of raw.matchAll(/(?:^|[\s（(，,【\[])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,12})(?:$|[\s。）)，,】\]:：/])/gm)) {
		const h = m[1].toLowerCase();
		if (!/^\d+(\.\d+)+$/.test(h)) hosts.add(h);
	}
	const skip = new Set(["e.g", "example.com", "localhost"]);
	const unified = () => [...hosts].filter((h) => !skip.has(h) && h.includes(".")).sort();

	switch (mode) {
		case "code-audit": {
			const out = new Set();
			for (const m of raw.matchAll(/[\w.-]+(?:\/[\w.-]+){1,6}\.(?:js|ts|py|java|go|php|rb|rs|cs|vue|jsx|tsx)/g)) out.add(m[0]);
			for (const m of raw.matchAll(/(?:^|[\s（(，,])(\/[a-z][\w-]*(?:\/[a-z][\w-]*){1,4})(?:$|[\s。）)，,])/gim)) out.add(m[1].toLowerCase());
			return [...out].sort().slice(0, 50);
		}
		case "binary-analysis": {
			const out = new Set();
			for (const m of raw.matchAll(/\b[0-9a-f]{32}\b|\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/gi)) out.add(m[0].toLowerCase());
			for (const m of raw.matchAll(/[\w.-]+\.(?:exe|dll|bin|elf|so|dylib|apk|ipa|dmg|sys)\b/gi)) out.add(m[0]);
			return [...out].sort().slice(0, 50);
		}
		case "cloud-security": {
			const out = new Set(unified());
			for (const m of raw.matchAll(/\barn:(?:aws|acs):[a-z0-9-]*:[a-z0-9-]*:\d{6,}:[\w:\/.-]+/gi)) out.add(m[0]);
			for (const m of raw.matchAll(/\b(?:aws|aliyun|tencent|huawei)\s*[_-]?\s*(?:account|uid)\s*[=:=]?\s*(\d{8,20})\b|(?:账号|账户)\s*[=:=]?\s*(\d{8,20})\b/gi)) { const id = m[1] ?? m[2]; if (id) out.add("account:" + id); }
			for (const m of raw.matchAll(/\b(ap-[a-z]+-\d|cn-[a-z]+[a-z]|us-[a-z]+-\d|eu-[a-z]+-\d)\b/g)) out.add(m[1]);
			return [...out].sort().slice(0, 50);
		}
		case "attack-defense": {
			const out = new Set(unified());
			for (const m of raw.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/g)) {
				const mask = Number(m[0].split("/")[1]);
				if (mask >= 8 && mask <= 32) { out.add(m[0]); out.delete(m[0].split("/")[0]); }
			}
			return [...out].sort().slice(0, 50);
		}
		case "av-evasion":
		case "ctf-solver":
		case "redteam":
			return [];
		default:
			return unified().slice(0, 50);
	}
}

//#endregion

function apply(ctx) {
	// 项目工作台 web 路由（只读 + 同源栅栏 + CSRF）。宿主没有 webServer（非 web 运行时）时静默跳过。
	try {
		if (ctx.webServer?.register) {
			const trustedHosts = () => {
				try { return ctx.webRuntime?.trustedHosts ?? []; } catch { return []; }
			};
			ctx.effect?.(() => ctx.webServer.register({
				kind: "prefix",
				path: PROJECT_ROUTE,
				handler: createProjectHandler({ trustedHosts }),
			}), "dsh-stage-gate: 项目工作台路由");
		}
	} catch { /* 路由注册失败不影响台账工具 */ }
	// 子代理生命周期回收（P1-9）。
	//
	// ⚠️ 两个实测约束（2026-09-18，真宿主 mock 子代理）：
	//  ① `subagent/start|end` 是**作用域事件**：dispatch 时用 parent 当 carrier，
	//     监听器只拿得到 `info`，**拿不到 parent**（生命周期发射器只回调 info）。
	//     所以在 apply 里写 `(info, parent) => …` 会永远拿到 undefined：
	//     必须按 agent 作用域注册（agent.ctx.on），把 agent 闭包进来。
	//  ② 事件 provider 是 provider id（原生工具是 `spawn`），不是工具名；
	//     别名表已补 `subagent`，所以 owner=subagent / owner=subagent_spawn 都能命中。
	const subagentBindings = new Map();
	// runId → taskId：start 时精确记下，end 时按 runId 回收（宿主重启后退回保守匹配）。
	// 有它才能分辨"同一 provider 并发跑了两个子代理"时哪一个对应哪条任务。
	const subagentRunBindings = new Map();
	const bindSubagentRecycle = (agent) => {
		const id = agent?.id;
		if (!id || !agent?.ctx || typeof agent.ctx.on !== "function") return;
		if (subagentBindings.has(id)) return;
		const intoLedger = (kind, info) => {
			try {
				const workspace = agent?.session?.header?.cwd;
				if (typeof workspace !== "string" || workspace === "") return;
				const sessionId = String(agent?.session?.id ?? "");
				const provider = String(info?.provider ?? "");
				const runId = String(info?.runId ?? "");
				if (kind === "start") {
					const started = startSubagentTask(workspace, { sessionId, provider });
					if (runId && started?.id) {
						if (subagentRunBindings.size >= 200) subagentRunBindings.delete(subagentRunBindings.keys().next().value);
						subagentRunBindings.set(runId, started.id);
					}
					return;
				}
				const exact = runId ? (subagentRunBindings.get(runId) ?? "") : "";
				if (runId) subagentRunBindings.delete(runId);
				finishSubagentTask(workspace, {
					sessionId,
					provider,
					stopReason: String(info?.stopReason ?? "completed"),
					summary: summarizeToolResult({ content: info?.lastAssistantMessage }),
					taskId: exact,
				});
			} catch { /* 回收是尽力而为：失败不影响子代理运行 */ }
		};
		const offStart = agent.ctx.on("subagent/start", (info) => intoLedger("start", info));
		const offEnd = agent.ctx.on("subagent/end", (info) => intoLedger("end", info));
		subagentBindings.set(id, { offStart, offEnd });
	};
	ctx.on?.("agent/created", (payload) => { try { bindSubagentRecycle(payload?.agent); } catch { /* 不影响创建 */ } });
	ctx.on?.("agent/inbox/inserted", (info) => { try { bindSubagentRecycle(info?.agent); } catch { /* 不影响投递 */ } });
	ctx.on?.("agent/disposed", (payload) => {
		const agent = payload?.agent ?? payload;
		const entry = subagentBindings.get(agent?.id);
		if (!entry) return;
		subagentBindings.delete(agent.id);
		for (const off of [entry.offStart, entry.offEnd]) {
			try { if (typeof off === "function") off(); } catch { /* 尽力释放 */ }
		}
	});
	ctx.tools.register(defineTool({
		name: "stage_gate",
		description: "校验阶段产物是否满足当前模式的结构门禁，判定写入 gate-log.md。进入下一阶段或接受 finding/报告前调用；结构 PASS 不等于语义全过，manual 项仍需复核。",
		parameters: {
			mode: { type: "string", required: true, enum: Object.keys(GATES), description: "Preset mode" },
			stage: { type: "string", required: true, description: "Gate id: pentest P1/P2/P3 · code-audit A1/A2/A3 · binary-analysis B0/B1/B2 · attack-defense recon/breach/lateral/persistence/report · av-evasion V1..V4 · incident-response I1..I5 · cloud-security C1..C7 · ctf-solver board/flag" },
			workspace: { type: "string", required: true, description: "Task workspace root (absolute, or relative to cwd)" },
			file: { type: "string", description: "Gate-scoped file path (report / chain / verdict log / plan) — required by per-finding gates; a relative path resolves against the workspace" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					pass: { type: "boolean", required: true },
					missing: { type: "array", required: true },
					manual: { type: "array", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: `stage_gate ${value.mode}/${value.stage}: ${value.pass ? "PASS" : "FAIL"}${value.missing.length ? ` — missing: ${value.missing.join(" ; ")}` : ""}${value.manual.length ? ` — manual review still required: ${value.manual.join(" ; ")}` : ""}` }]
		},
		execute(args) {
			const workspace = path.resolve(args.workspace);
			const verdict = runGate(fs, { ...args, workspace });
			try { appendGateLog(workspace, verdict); } catch { /* audit-write failure never flips the verdict */ }
			try { syncOperationState(workspace, verdict); } catch { /* state-sync failure never flips the verdict */ }
			return Promise.resolve(verdict);
		}
	}));
	ctx.tools.register(defineTool({
		name: "operation_goal",
		description: "把任务目标登记为可判定契约：一句话目标 + 每条独立可验证的成功准则。任务开始、首次 stage_gate 前登记；准则经 operation_progress 逐条收口。",
		parameters: {
			workspace: { type: "string", required: true, description: "Task workspace root (absolute, or relative to cwd)" },
			goal: { type: "string", required: true, description: "目标一句话（≤500 字符）" },
			criteria: { type: "string", required: true, description: "成功准则，每行一条（可判定表述，如「getshell 证据：whoami 输出与 evidence 编号」「全量 12 条路由均给出终态」），≤20 条" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_args, v) => [{ type: "text", text: v.ok ? `${v.mode ? `【${v.mode} 拆分理论】${v.theory}——准则结构：${v.criteriaGuide}（例：${v.example}）。` : ""}目标契约已登记：${v.total} 条准则（${v.ids.join(", ")}）。逐条 met 用 operation_progress；全部 met + 报告门通过后才可写 reports/。${v.scopeDraft?.length ? `下一步（开工三登记）：operation_constraints 登记用户约束（deny/allow）；operation_scope 登记范围分母${v.scopeSemantics ? `（${v.scopeSemantics}）` : ""}——草稿已从目标提取：${v.scopeDraft.join("、")}（确认或改，保守派生只取精确形态不放大）。` : "下一步：operation_constraints 登记用户约束、operation_scope 登记范围分母（登记即激活对账/推进/门禁）。"}` : `登记失败：${v.error}` }]
		},
		execute(args, exec) {
			try {
				const workspace = path.resolve(args.workspace);
				const st = setGoal(workspace, args.goal, args.criteria);
				const mode = modeOfExec(ctx, exec);
				const prevScope = Array.isArray(readOperationState(fs, workspace)?.scope) && readOperationState(fs, workspace).scope.length > 0;
				const scopeDraft = prevScope ? [] : deriveScopeDraft([args.goal, args.criteria], mode);
				const d = mode ? DECOMPOSITION[mode] : undefined;
				return Promise.resolve({ ok: true, total: st.criteria.length, ids: st.criteria.map((c) => c.id), scopeDraft, mode, theory: d?.theory, criteriaGuide: d?.criteriaGuide, example: d?.example, scopeSemantics: d?.scopeSemantics });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "operation_constraints",
		description: "登记用户明确给出的操作约束。每行 `deny: 文本 [:: kw1,kw2]` 或 `allow: 文本`；带匹配词的 deny 接确定性拦截。只登记明确约束，不臆造；整表替换。",
		parameters: {
			workspace: { type: "string", required: true, description: "Task workspace root" },
			items: { type: "string", required: true, description: "约束条目，每行一条：`deny: 不碰支付接口 :: pay,payment,refund`、`allow: 仅测 x.example.com`——≤30 条" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_args, v) => [{ type: "text", text: v.ok ? `${v.constraintHints ? `【${v.mode} 约束面提示】${v.constraintHints}。` : ""}约束已登记：${v.total} 条（禁 ${v.deny}·含确定性拦截 ${v.denyGuarded} / 允 ${v.allow}）——${v.lines.slice(0, 5).join("；")}。带匹配词的 deny 命中 bash/fetch 即拦；全部约束每轮进信封防压缩丢失。` : `登记失败：${v.error}` }]
		},
		execute(args, exec) {
			try {
				const mode = modeOfExec(ctx, exec);
				return Promise.resolve({ ok: true, ...setConstraints(path.resolve(args.workspace), args.items), mode, constraintHints: mode ? DECOMPOSITION[mode]?.constraintHints : undefined });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "operation_progress",
		description: "收口/重开目标准则并维护待办。met 项应附证据引用；返回剩余准则，all-met 表示目标契约满足。",
		parameters: {
			workspace: { type: "string", required: true, description: "Task workspace root" },
			met: { type: "string", description: "已达成准则 id（逗号/空格分隔，如 g1 g3）" },
			failed: { type: "string", description: "证伪准则 id（该准则按失败收口）" },
			reopened: { type: "string", description: "重开准则 id（回 open）" },
			tested: { type: "string", description: "标记已测的 scope id（逗号/空格分隔；须先 operation_scope 登记）" },
			evidence: { type: "string", description: "tested 的证据指位（必填：evidence 编号/覆盖矩阵行/输出文件路径）" },
			pending: { type: "string", description: "待办动作清单（整表替换，每行一条；空串=清空）" },
			note: { type: "string", description: "进度注记（≤500 字符）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { verdict: { type: "string", required: true } } },
			render: (_args, v) => [{ type: "text", text: `operation 进度：已收口 ${(v.met ?? 0) + (v.failed ?? 0)}/${v.total}（met ${v.met ?? 0}${v.failed ? ` / failed ${v.failed}` : ""}）${v.openIds?.length ? `，未收口 ${v.openIds.join(", ")}` : ""}${v.pending?.length ? `，待办 ${v.pending.length} 项` : ""}——${v.verdict === "all-met" ? "准则均已给出结论（met/failed），可按报告门继续" : "收口后才可产出 reports/"}` }]
		},
		execute(args) {
			try {
				const workspace = path.resolve(args.workspace);
				const summary = updateProgress(workspace, args);
				if (args.tested) summary.coverage = markTested(workspace, args.tested, args.evidence);
				return Promise.resolve(summary);
			} catch (e) {
				return Promise.resolve({ verdict: "error", error: e?.message ?? String(e) });
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "operation_scope",
		description: "登记覆盖分母：每行一个范围项，支持自动 id 或 `id: label`。只登记目标明确要求或派生必需的面，不擅自放大；报告门按 M/N 对账。",
		parameters: {
			workspace: { type: "string", required: true, description: "Task workspace root" },
			items: { type: "string", required: true, description: "范围项，每行一条（标签 或 id: 标签），≤200 项——如「10.0.0.5 Web 前台\n10.0.0.6 API 网关\napi-docs 路由全集」" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_args, v) => [{ type: "text", text: v.ok ? `${v.scopeSemantics ? `【${v.mode} 分母语义】${v.scopeSemantics}。` : ""}范围台账已登记：${v.scope} 项（已测 ${v.tested}${v.untested ? `，未测 ${v.untestedIds.slice(0, 10).join(", ")}${v.untested > 10 ? " 等" : ""}` : ""}）。已测标记：operation_progress tested=<ids> evidence=<指位>；报告门将按台账对账「覆盖：${v.tested}/${v.scope}」。` : `登记失败：${v.error}` }]
		},
		execute(args, exec) {
			try {
				const mode = modeOfExec(ctx, exec);
				return Promise.resolve({ ok: true, ...setScope(path.resolve(args.workspace), args.items), mode, scopeSemantics: mode ? DECOMPOSITION[mode]?.scopeSemantics : undefined });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "operation_intent",
		description: "登记新方向及强制证据锚点：boot / criterion / scope / finding / chain。收口走 operation_progress，blocked/dropped 须写原因；未收口会拦报告。",
		parameters: {
			workspace: { type: "string", required: true, description: "Task workspace root" },
			summary: { type: "string", required: true, description: "一句话方向（做什么、追什么线索）≤200 字符" },
			anchor_kind: { type: "string", required: true, enum: ANCHOR_KINDS, description: "锚点类型（boot=开局豁免，其余须带 anchor_ref）" },
			anchor_ref: { type: "string", description: "锚点 id（boot 省略；criterion/scope/finding/chain 必填）" },
			note: { type: "string", description: "备注（派单对象/预期产出等 ≤300 字符）" },
			owner: { type: "string", description: "任务执行者（可选；填了就建立执行状态）" },
			max_attempts: { type: "number", description: "最大尝试次数（1-20，默认 1）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_args, v) => [{ type: "text", text: v.ok ? `意图已登记：${v.id}（锚=${v.anchor}）。收口：operation_progress intent_done/intent_blocked/intent_dropped（blocked/dropped 附原因）；未收口意图拦报告。当前 ${v.open}/${v.total} 未收口。` : `登记失败：${v.error}` }]
		},
		// 曾经写成 `(async () => { … })()` 的 fire-and-forget：外层没有 return，
		// execute 返回 undefined → 宿主 `validateJsonSchemaValue(output.schema, undefined)` 判违反
		// 必填 `ok` → 抛 ToolOutputError：
		//   Error: tool "operation_intent" returned invalid output: value is not lossless JSON
		// 后果：**意图其实已异步登记成功，但模型收到的是「调用失败」** —— 实战里会重复登记或直接放弃方向。
		// 实测在真实会话里连续两次都报这个错（transcript 的 tool/result 有 ToolOutputError）。
		async execute(args, exec) {
			try {
				const agent = exec?.agent;
				const sessionId = agent?.session?.id ? String(agent.session.id) : "";
				let mode = "";
				try { mode = String(ctx.agentPresets?.composedPreset?.(agent?.ctx) ?? ""); } catch { /* 组合未就绪 */ }
				const resolvers = await theResolvers();
				const s = registerIntent(path.resolve(args.workspace), { summary: args.summary, anchorKind: args.anchor_kind, anchorRef: args.anchor_ref, note: args.note, owner: args.owner, maxAttempts: args.max_attempts, sessionId, mode }, resolvers);
				return { ok: true, id: `i${s.total}`, anchor: `${args.anchor_kind}${args.anchor_ref ? ":" + args.anchor_ref : ""}`, open: s.open, total: s.total };
			} catch (e) {
				return { ok: false, error: e?.message ?? String(e) };
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "operation_task",
		description: "推进 intent 的执行状态：start/heartbeat/progress/succeed/fail/cancel/retry/interrupt。仅对登记了 task 的意图有效。",
		parameters: {
			workspace: { type: "string", required: true, description: "Task workspace root" },
		id: { type: "string", description: "intent id（如 i1；action=claim 时省略）" },
		action: { type: "string", required: true, enum: ["claim", "start", "heartbeat", "progress", "succeed", "fail", "cancel", "retry", "interrupt", "update"], description: "claim=原子领取下一个 queued 任务；其余动作传 id" },
			owner: { type: "string", description: "执行者" },
			progress: { type: "number", description: "进度 0-100" },
			result: { type: "string", description: "结果摘要" },
			error: { type: "string", description: "失败/中断原因" },
			artifacts: { type: "array", items: { type: "string" }, description: "产物路径列表" },
			note: { type: "string", description: "操作注记" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_args, v) => [{ type: "text", text: v.ok ? `任务 ${v.id}：${v.task.state} ${v.task.progress}% attempts ${v.task.attempts}/${v.task.maxAttempts}${v.task.error ? `｜${v.task.error}` : ""}` : `任务操作失败：${v.error}` }]
		},
		execute(args) {
			try {
				if (args.action === "claim") return Promise.resolve({ ok: true, ...taskClaim(path.resolve(args.workspace), args) });
				return Promise.resolve({ ok: true, ...taskTransition(path.resolve(args.workspace), args) });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "operation_conclude",
		description: "申请结束任务，结束条件由系统判定。存在 open 准则或意图会被驳回并返回清单；全部收口后直接结束本轮。failed 是有效终态。",
		parameters: {
			workspace: { type: "string", required: true, description: "Task workspace root" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_args, v) => [{ type: "text", text: v.ok
				? (v.canConclude
					? `结束已获准：${v.reason}${v.blockers && v.blockers.length ? "" : "。本轮到此收尾。"}`
					: `结束**被驳回**：${v.reason}`)
				: `判定失败：${v.error}` }]
		},
		async execute(args, exec) {
			try {
				const workspace = path.resolve(String(args.workspace));
				const st = readOperationState(fs, workspace);
				const verdict = conclusionVerdict(st);
				if (verdict.canConclude) {
					// 系统认可 → 让本轮**立即干净收尾**（宿主级：这条成功结果标记为终结）。
					// 这是本工具存在的意义：模型申请、系统放行，而不是模型自己说"我完成了"。
					try { exec?.concludeTurn?.(); } catch { /* 老宿主无此 API 时降级为普通结果 */ }
				}
				return {
					ok: true,
					canConclude: verdict.canConclude,
					reason: verdict.reason,
					blockers: verdict.blockers,
					criteria: verdict.criteria,
					intents: verdict.intents,
				};
			} catch (e) {
				return { ok: false, error: e?.message ?? String(e) };
			}
		}
	}));
	ctx.tools.register(defineTool({
		name: "gates_list",
		description: "列出各模式的门禁、规范文件名、file 参数要求和人工复核项。工作区创建后或调用 stage_gate 前先读。",
		parameters: {
			mode: { type: "string", enum: Object.keys(GATES), description: "Omit to list every mode" }
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
		},
		execute(args) {
			return Promise.resolve(listGates(args.mode));
		}
	}));
}

export { GATES, REPORT_GATES, apply, inject, name, setGoal, updateProgress, syncOperationState, STATE_FILE };

//#endregion
