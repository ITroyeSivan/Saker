import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const SSH_BASE = [
	"-o", "StrictHostKeyChecking=no",
	"-o", "UserKnownHostsFile=NUL",
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
];
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const MAX_FILES_BYTES = 2 * 1024 * 1024;
let labCache = null;

function stamp() {
	return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 17) + "-" + randomBytes(6).toString("hex");
}

function hashBytes(value) {
	return createHash("sha256").update(value).digest("hex");
}

function hashFile(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listFiles(root) {
	const out = [];
	if (!fs.existsSync(root)) return out;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(file);
			else if (entry.isFile()) out.push(file);
		}
	}
	return out.sort();
}

function runProcess(bin, args, { timeoutMs = 60_000, cwd, maxBuffer = 32 * 1024 * 1024 } = {}) {
	return new Promise((resolve) => {
		const stdout = [];
		const stderr = [];
		let size = 0;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		let child;
		try {
			child = spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			finish({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error });
			return;
		}
		const timer = setTimeout(() => {
			try { child.kill(); } catch { /* already gone */ }
		}, timeoutMs);
		const collect = (target, chunk) => {
			size += chunk.length;
			if (size <= maxBuffer) target.push(chunk);
		};
		child.stdout?.on("data", (chunk) => collect(stdout, chunk));
		child.stderr?.on("data", (chunk) => collect(stderr, chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({ status: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error });
		});
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			const error = size > maxBuffer
				? Object.assign(new Error("命令输出超过上限"), { code: "ENOBUFS" })
				: undefined;
			finish({ status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error });
		});
	});
}

function readLabConfig() {
	const file = String(process.env.SAKER_LAB_CONFIG || "").trim();
	if (!file) throw new Error("未配置 SAKER_LAB_CONFIG；先在桌面启动器里指向 lab.json");
	let config;
	try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
		throw new Error("无法读取 lab.json：" + (error?.message || error));
	}
	for (const key of ["vmx", "vmrun", "host", "user", "sshKey"]) {
		if (!config[key] || typeof config[key] !== "string") throw new Error("lab.json 缺少 " + key);
	}
	if (!fs.existsSync(config.sshKey)) throw new Error("lab SSH key 不存在");
	if (!fs.existsSync(config.vmrun)) throw new Error("vmrun 不存在");
	return { ...config, file };
}

function sshArgs(config, command) {
	return [...SSH_BASE, "-i", config.sshKey, `${config.user}@${config.host}`, command];
}

function scpArgs(config, sources, target) {
	return [...SSH_BASE, "-i", config.sshKey, "-r", ...sources, `${config.user}@${config.host}:${target}`];
}

function scpFromArgs(config, remoteSource, localTarget) {
	return [...SSH_BASE, "-i", config.sshKey, "-r", `${config.user}@${config.host}:${remoteSource}`, localTarget];
}

async function ensureLab(config) {
	const key = config.file + "|" + config.host;
	if (labCache && labCache.key === key && Date.now() - labCache.at < 30_000) return labCache;
	const vm = await runProcess(config.vmrun, ["-T", "ws", "list"], { timeoutMs: 15_000 });
	if (vm.error || vm.status !== 0 || !vm.stdout.toString().includes(config.vmx)) {
		const start = await runProcess(config.vmrun, ["-T", "ws", "start", config.vmx, "nogui"], { timeoutMs: 60_000 });
		if (start.error || start.status !== 0) {
			throw new Error("隔离 VM 未运行且启动失败：" + (start.error?.message || start.stderr.toString().slice(0, 300)));
		}
		const ip = await runProcess(config.vmrun, ["-T", "ws", "getGuestIPAddress", config.vmx, "-wait", "2"], { timeoutMs: 45_000 });
		const value = ip.stdout.toString().trim();
		if (ip.status === 0 && value) config.host = value;
	}
	const info = await runProcess("ssh", sshArgs(config, "sudo docker info --format '{{.ServerVersion}}'"), { timeoutMs: 30_000 });
	if (info.error || info.status !== 0) {
		throw new Error("隔离 VM 的 Docker 不可用：" + (info.error?.message || info.stderr.toString().slice(0, 300)));
	}
	const result = { key, at: Date.now(), version: info.stdout.toString().trim(), host: config.host };
	labCache = result;
	return result;
}

function validateImage(value, label) {
	const image = String(value || "").trim();
	if (!IMAGE_RE.test(image)) throw new Error(label + " 镜像名不合法");
	return image;
}

function writeWorkspaceFiles(root, files) {
	if (files === undefined || files === null) return;
	if (typeof files !== "object" || Array.isArray(files)) throw new Error("files 必须是对象");
	let total = 0;
	for (const [name, content] of Object.entries(files)) {
		const value = String(content ?? "");
		const relative = String(name || "").replace(/\\/g, "/");
		if (!relative || relative.startsWith("/") || relative.includes("../") || relative === "run-a.sh" || relative === "run-b.sh") {
			throw new Error("files 路径不合法：" + name);
		}
		total += Buffer.byteLength(value, "utf8");
		if (total > MAX_FILES_BYTES) throw new Error("files 超过 2MB");
		const target = path.resolve(root, relative);
		if (!target.startsWith(root + path.sep)) throw new Error("files 越出工作区：" + name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, value);
	}
}

function outputSummary(root) {
	return listFiles(root).map(file => ({
		path: path.relative(root, file).replace(/\\/g, "/"),
		bytes: fs.statSync(file).size,
		sha256: hashFile(file),
	}));
}

export async function runVersionReproduce({ workspace, args, nextEvidenceId, appendEvidence }) {
	const config = readLabConfig();
	const lab = await ensureLab(config);
	const imageA = validateImage(args.imageA, "imageA");
	const imageB = validateImage(args.imageB, "imageB");
	const commandA = String(args.commandA || "").trim();
	const commandB = String(args.commandB || "").trim();
	if (!commandA || !commandB) throw new Error("commandA / commandB 不能为空");
	const timeoutMs = Math.min(180, Math.max(10, Number(args.timeoutSec) || 60)) * 1000;
	const run = `run-${stamp()}`;
	const localRoot = path.join(workspace, "artifacts", "version-reproduction", run);
	const localWork = path.join(localRoot, "work");
	fs.mkdirSync(localWork, { recursive: true });
	writeWorkspaceFiles(localWork, args.files);
	fs.writeFileSync(path.join(localWork, "run-a.sh"), "#!/bin/sh\nset -eu\n" + commandA + "\n");
	fs.writeFileSync(path.join(localWork, "run-b.sh"), "#!/bin/sh\nset -eu\n" + commandB + "\n");
	const remoteRoot = `/tmp/saker-repro-${run}`;
	const remoteWork = remoteRoot + "/work";
	const remoteOutA = remoteRoot + "/outA";
	const remoteOutB = remoteRoot + "/outB";
	const cleanup = async () => {
		await runProcess("ssh", sshArgs(config, `rm -rf ${remoteRoot}`), { timeoutMs: 20_000 });
	};
	try {
		const mk = await runProcess("ssh", sshArgs(config, `mkdir -p ${remoteRoot}`), { timeoutMs: 20_000 });
		if (mk.error || mk.status !== 0) throw new Error("无法创建 VM 临时目录：" + mk.stderr.toString().slice(0, 300));
		const copied = await runProcess("scp", scpArgs(config, [localWork], remoteRoot + "/"), { timeoutMs: 60_000 });
		if (copied.error || copied.status !== 0) throw new Error("无法复制复现文件到 VM：" + copied.stderr.toString().slice(0, 300));
		const runVariant = async (label, image, script, remoteOut) => {
			const mkOut = await runProcess("ssh", sshArgs(config, `mkdir -p ${remoteOut}`), { timeoutMs: 20_000 });
			if (mkOut.error || mkOut.status !== 0) throw new Error(`无法创建 ${label} 输出目录`);
			const docker = [
				"sudo", "docker", "run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
				"-v", `${remoteWork}:/work:ro`, "-v", `${remoteOut}:/out:rw`, "-w", "/work", image, "sh", `/work/${script}`,
			].join(" ");
			const result = await runProcess("ssh", sshArgs(config, docker), { timeoutMs });
			if (result.error) throw new Error(`${label} 执行失败：${result.error.message}`);
			if (result.status === null) throw new Error(`${label} 执行超时或被终止（${result.signal || "unknown"}）`);
			if (result.status === 255) throw new Error(`${label} SSH 执行失败：${result.stderr.toString().slice(0, 300)}`);
			const localOut = path.join(localRoot, label === "A" ? "outA" : "outB");
			if (fs.existsSync(localOut)) fs.rmSync(localOut, { recursive: true, force: true });
			const back = await runProcess("scp", scpFromArgs(config, remoteOut, localRoot + "/"), { timeoutMs: 60_000 });
			if (back.error || back.status !== 0) throw new Error(`${label} 输出回传失败：${back.stderr.toString().slice(0, 300)}`);
			if (!fs.existsSync(localOut)) fs.mkdirSync(localOut, { recursive: true });
			return {
				label, image,
				commandSha256: hashBytes(Buffer.from(label === "A" ? commandA : commandB)),
				exitStatus: result.status,
				stdout: result.stdout.toString(),
				stderr: result.stderr.toString(),
				outputs: outputSummary(localOut),
			};
		};
		const a = await runVariant("A", imageA, "run-a.sh", remoteOutA);
		const b = await runVariant("B", imageB, "run-b.sh", remoteOutB);
		const comparison = {
			sameExit: a.exitStatus === b.exitStatus,
			sameStdout: a.stdout === b.stdout,
			sameStderr: a.stderr === b.stderr,
			sameOutputs: JSON.stringify(a.outputs) === JSON.stringify(b.outputs),
		};
		comparison.behaviorDiff = !(comparison.sameExit && comparison.sameStdout && comparison.sameStderr && comparison.sameOutputs);
		const stdoutFile = path.join(localRoot, "stdout.txt");
		const stderrFile = path.join(localRoot, "stderr.txt");
		fs.writeFileSync(stdoutFile, `=== A ===\n${a.stdout}\n=== B ===\n${b.stdout}\n`);
		fs.writeFileSync(stderrFile, `=== A ===\n${a.stderr}\n=== B ===\n${b.stderr}\n`);
		a.stdout = "stdout.txt";
		a.stderr = "stderr.txt";
		b.stdout = "stdout.txt";
		b.stderr = "stderr.txt";
		const summary = {
			run, lab: { host: lab.host, dockerVersion: lab.version },
			inputFiles: outputSummary(localWork).filter(file => !file.path.startsWith("run-")),
			A: a, B: b, comparison,
			note: "容器使用 --network none；输出差异是行为观察，不等于漏洞。",
		};
		const summaryFile = path.join(localRoot, "summary.json");
		fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
		const relative = path.relative(workspace, summaryFile).replace(/\\/g, "/");
		const evidenceId = nextEvidenceId(workspace);
		appendEvidence(workspace, evidenceId, `version_reproduce A=${imageA} B=${imageB}`, relative);
		await cleanup();
		return {
			ok: true, evidenceId, artifact: relative,
			A: { exitStatus: a.exitStatus, outputs: a.outputs.length },
			B: { exitStatus: b.exitStatus, outputs: b.outputs.length },
			comparison,
			text: `version_reproduce：A=${imageA} exit ${a.exitStatus}，B=${imageB} exit ${b.exitStatus}；行为差异=${comparison.behaviorDiff}；证据 ${evidenceId}；总结 ${relative}。结果只是隔离行为观察，不等于漏洞。`,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
