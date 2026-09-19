#!/usr/bin/env node
// Deterministic task-queue/recovery baseline for Saker's stage-gate state.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	setGoal, registerIntent, updateProgress, taskTransition, readOperationState,
} from "../plugins/dsh-stage-gate/lib/index.js";

const workspace = mkdtempSync(join(tmpdir(), "saker-task-baseline-"));
const result = {};
try {
	const total = 40;
	setGoal(workspace, "任务成功率基线", "g1 任务状态全部可收口");
	for (let i = 0; i < total; i += 1) {
		registerIntent(workspace, { summary: `task-${i}`, anchorKind: "boot", owner: `worker-${i}`, maxAttempts: 3 });
	}

	for (let i = 0; i < 25; i += 1) {
		const id = `i${i + 1}`;
		taskTransition(workspace, { id, action: "start" });
		taskTransition(workspace, { id, action: "succeed", result: "ok" });
	}
	for (let i = 25; i < 33; i += 1) {
		const id = `i${i + 1}`;
		taskTransition(workspace, { id, action: "start" });
		taskTransition(workspace, { id, action: "fail", error: "transient" });
		taskTransition(workspace, { id, action: "retry" });
		taskTransition(workspace, { id, action: "start" });
		taskTransition(workspace, { id, action: "succeed", result: "recovered" });
	}
	for (let i = 33; i < 37; i += 1) {
		const id = `i${i + 1}`;
		taskTransition(workspace, { id, action: "start" });
		taskTransition(workspace, { id, action: "fail", error: "permanent" });
	}
	const stale = [];
	for (let i = 37; i < total; i += 1) {
		const id = `i${i + 1}`;
		taskTransition(workspace, { id, action: "start" });
		stale.push(id);
	}
	const state = readOperationState({ readFileSync, writeFileSync }, workspace);
	for (const id of stale) state.intents.find((intent) => intent.id === id).task.heartbeatAt = "2000-01-01T00:00:00.000Z";
	writeFileSync(join(workspace, "operation-state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
	updateProgress(workspace, { note: "recover stale" });
	for (const id of stale) {
		taskTransition(workspace, { id, action: "retry" });
		taskTransition(workspace, { id, action: "start" });
		taskTransition(workspace, { id, action: "succeed", result: "recovered-after-interrupt" });
	}

	const finalState = readOperationState({ readFileSync, writeFileSync }, workspace);
	const tasks = finalState.intents.map((intent) => intent.task).filter(Boolean);
	const succeeded = tasks.filter((task) => task.state === "succeeded").length;
	const failed = tasks.filter((task) => task.state === "failed").length;
	const tasksWithRetry = tasks.filter((task) => task.attempts > 1).length;
	result.total = total;
	result.succeeded = succeeded;
	result.failed = failed;
	result.tasksWithRetry = tasksWithRetry;
	result.taskSuccessRate = succeeded / total;
	result.recoveryTasks = stale.length;
	result.recoveryRate = stale.every((id) => finalState.intents.find((intent) => intent.id === id).task.state === "succeeded")
		? 1
		: 0;
	result.attemptsTotal = tasks.reduce((sum, task) => sum + task.attempts, 0);

	console.log(`task-baseline total=${total} succeeded=${succeeded} failed=${failed} success=${(result.taskSuccessRate * 100).toFixed(1)}% retryTasks=${tasksWithRetry} recovery=${(result.recoveryRate * 100).toFixed(1)}%`);
	if (succeeded + failed !== total || result.taskSuccessRate < 0.9 || result.recoveryRate !== 1) process.exitCode = 1;
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
