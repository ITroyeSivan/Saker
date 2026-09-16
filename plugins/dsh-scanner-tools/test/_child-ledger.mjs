import { persistScanRecords } from "../lib/index.js";

const workspace = process.argv[2];
const id = persistScanRecords(workspace, {
	command: `child ${process.pid}`,
	file: `artifacts/${process.pid}.json`,
	rows: [{ source: "concurrency", hit: `pid:${process.pid}` }],
});
console.log(id);
