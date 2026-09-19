// 报告草稿渲染（纯函数，零依赖）：把一条结构化 finding 变成六字段报告草稿。
//
// 为什么单独放在根包：这样任何宿主里的代码都能引用（`dsh-saker/report-drafts`），
// 而"去哪个库读 findings、往哪个目录写"留在脚本侧（那里才有跨插件路径）。
//
// 两条自我约束（测试锁死了）：
//  1) 编不出来的字段如实标 `（待补：…）`，**绝不用占位文字伪造可过门禁的内容**；
//  2) 待补提示文案里**不能出现门禁要检查的关键词**（对照三件套/独立复核的原文词），
//     否则生成器自己的占位文案就能把 P2 结构门禁骗过去。
export const SEVERITY_LABEL = { critical: "严重", high: "高危", medium: "中危", low: "低危" };
export const STATUS_LABEL = {
	pending: "待验证", "code-reviewed": "代码侧已复核", suspect: "疑似·未定论", verified: "已验证",
	"false-positive": "误报", fixed: "已修复",
};
export const EVIDENCE_LABEL = { impact: "影响已证", confirmed: "已证实", partial: "部分证据", unknown: "未知" };

/** 标题 → 文件名安全片段（保留中文，去掉路径与分隔符）。 */
export function slugify(title, max = 40) {
	const cleaned = String(title ?? "").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
	return (cleaned || "finding").slice(0, max);
}

/** 报告文件名：`NN-标题.md`（NN 用台账序号，保证与成果页一致）。 */
export function draftFileName(finding) {
	return `${String(finding?.seq ?? 0).padStart(2, "0")}-${slugify(finding?.title)}.md`;
}

function section(title, body) {
	return `## ${title}\n\n${body && String(body).trim() !== "" ? String(body).trim() : `（待补：${title}）`}\n`;
}

/** 单条 finding → 六字段报告草稿。 */
export function renderDraft(finding) {
	const severity = String(finding?.severity ?? "");
	const status = String(finding?.status ?? "");
	const evidenceLevel = String(finding?.evidenceLevel ?? "");
	const lines = [
		`# ${finding?.title ?? "（未命名）"}`,
		"",
		section("漏洞/问题 名称", finding?.title),
		section("漏洞/问题 描述", [finding?.description, finding?.summary].filter(Boolean).join("\n\n")),
		section("漏洞/问题 等级", `${SEVERITY_LABEL[severity] ?? severity ?? ""}（${severity || "未评级"}）${finding?.cvss ? ` · CVSS ${finding.cvss}` : ""}`),
		section("漏洞/问题 地址", finding?.target),
	];

	const process = [];
	if (finding?.poc) process.push(String(finding.poc).trim());
	if (finding?.baseline) process.push(`- 基线：${String(finding.baseline).trim()}`);
	if (finding?.diffEvidence) process.push(`- 差分：${String(finding.diffEvidence).trim()}`);
	if (finding?.markerEcho) process.push(`- marker 回显：${String(finding.markerEcho).trim()}`);
	if (finding?.requestPkt) process.push(`- 请求报文：\n\n\`\`\`\n${String(finding.requestPkt).trim()}\n\`\`\``);
	if (finding?.responsePkt) process.push(`- 响应报文：\n\n\`\`\`\n${String(finding.responsePkt).trim()}\n\`\`\``);
	if (finding?.chain) process.push(`- 利用链：${String(finding.chain).trim()}`);
	const missing = [];
	if (!finding?.baseline) missing.push("baseline");
	if (!finding?.diffEvidence) missing.push("diff");
	if (!finding?.markerEcho) missing.push("marker");
	lines.push(section("测试过程", [
		process.join("\n\n"),
		missing.length ? "（待补：对照三件套与独立验证结论——按本模式 playbook 补齐后再过阶段门）" : "",
	].filter(Boolean).join("\n\n")));
	lines.push(section("修复建议", finding?.fix));

	const evidence = [
		`- 证据等级：${EVIDENCE_LABEL[evidenceLevel] ?? (evidenceLevel || "未知")}`,
		`- 状态：${STATUS_LABEL[status] ?? (status || "待验证")}`,
		finding?.secondRating ? `- 二次评级：${finding.secondRating}${finding?.secondRatingNote ? `（${finding.secondRatingNote}）` : ""}` : "",
		finding?.verifyNote ? `- 复核：${finding.verifyNote}` : "",
		finding?.evidence ? `- 证据引用：${finding.evidence}` : "",
		finding?.retestNote ? `- 复测：${finding.retestNote}` : "",
	].filter(Boolean).join("\n");
	lines.push(`## 证据与独立验证\n\n${finding?.verifyNote ? "" : "（待补：独立验证结论——不得由发现者自证）\n\n"}${evidence}\n`);
	return lines.join("\n");
}
