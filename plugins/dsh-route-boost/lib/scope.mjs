// Deterministic task focus detection, independent of retired UI plugins.
import { TASK_TERMS } from './task-terms.mjs';
function taxonomyItems(presetId) {
	return TASK_TERMS[presetId] ?? [];
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s　]/g, "");
const EXPLICIT_RE = /(只测|只做|只查|只检查|仅测|仅做|仅查|只看|只挖|专项|针对性|别的不用|其他不用|其他别测|不用全|不全测|不要全)/;
const GENERIC_RE = /(注入|xss|csrf|ssrf|xss漏洞|越权|未授权|横向|提权|泄露|弱口令|默认口令|上传|下载|反序列化|rce|命令执行|逻辑漏洞|支付|越级|接管|劫持|文件包含|遍历|爆破|钓鱼|免杀|加壳|脱壳|内存马|webshell)/;
const ACTION_RE = /(测|测一下|测试|测下|查|查一下|检查|验证|试试|试下|挖掘|找找|看下|看看|打一下|打下)/;

/** 类目命中：全名匹配优先，括注前缀（「XSS（反射/…」→ XSS）次之；短名防误命中。 */
function labelHits(labels, text) {
	const t = norm(text);
	if (!t) return [];
	const hits = [];
	const seen = new Set();
	for (const raw of labels) {
		const full = norm(raw);
		const head = norm(raw.split(/（|\(|·|\/|、/)[0]);
		const cand = full.length >= 3 && t.includes(full) ? raw : (head.length >= 3 && t.includes(head) ? head : "");
		if (cand && !seen.has(cand)) { seen.add(cand); hits.push(cand); }
	}
	return hits;
}

/** 判定任务口径。返回 { directed, hits, explicit }——确定性：同文本同结论。 */
export function detectScope(presetId, text) {
	const t = norm(text);
	if (!t) return { directed: false, hits: [], explicit: false };
	const explicit = EXPLICIT_RE.test(t);
	const hits = labelHits(taxonomyItems(presetId), text);
	const generic = GENERIC_RE.test(t) && ACTION_RE.test(t);
	const directed = explicit || hits.length > 0 || generic;
	return { directed, hits, explicit };
}
