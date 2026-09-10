// 回归测试：证据落盘所有权（ffuf -o 自写文件不得被 stdout 兜底覆盖）
// 背景：ffufParse 返回 __writeRaw:null，旧逻辑走 else 分支把 -o 写出的 JSON 覆盖成 {raw:stdout}，
//      扫描命中的结构化数组消失而工具仍报成功——证据完整性问题。
// 本测试用 node 自身冒充二进制（可控写出/不写出），验证三条分支。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScan, ffufParse } from "../lib/index.js";

let failed = 0;
const expect = (n, c, d) => { if (c) console.log(`ok   ${n}`); else { failed++; console.log(`FAIL ${n} ${d ?? ""}`); } };

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-persist-"));
const scans = path.join(ws, "artifacts", "scans");
fs.mkdirSync(scans, { recursive: true });

// 假"二进制"：node -e <script> -- -o <file> -rate <n>
// 写入工具自产的 JSON（模拟 ffuf -of json）；WRITE=0 时不写，用于验证兜底分支。
const mkScript = (write) => `const fs=require("fs");const a=process.argv.slice(1);const i=a.indexOf("-o");if(${write})fs.writeFileSync(a[i+1],JSON.stringify([{url:"http://t/admin",status:200,length:1234}],null,2));process.exit(0);`;

function run(tool, outFile, parseFn, write) {
  return runScan({
    // hasBin() 走 `where <bin>`，只认 PATH 名字，绝对路径会被判为无效模式 → 用 "node"
    bin: "node",
    args: ["-e", mkScript(write), "--", "-o", outFile],
    workspace: ws, tool, rate: undefined, defaultRate: 50,
    active: false, target: "http://t/", parse: parseFn, outFile: outFile,
  });
}

// 分支 1：工具自写 + parse 声明 __skipWrite → 文件必须保留工具产出的 JSON
// （用真实的 ffufParse，覆盖"解析→落盘"真实接线，而非仿制品）
const f1 = path.join(scans, "ffuf-self.json");
run("ffuf", f1, ffufParse, 1);
const c1 = fs.existsSync(f1) ? fs.readFileSync(f1, "utf8") : "";
expect("自写文件不被覆盖（保留结构化数组）", c1.includes('"url"') && c1.includes('"status"'), `实际=${c1.slice(0, 80)}`);

// 分支 2：声明 __skipWrite 但工具未写出 → 兜底回写 stdout，证据指针不悬空
const f2 = path.join(scans, "ffuf-missing.json");
run("ffuf", f2, ffufParse, 0);
expect("自写缺失时兜底建文件（指针不悬空）", fs.existsSync(f2), "文件不存在");

// 分支 3：既有行为回归——parse 交出 __writeRaw 时仍由框架落盘
// （用 ffuf 而非 nuclei：nuclei 有模板库前置校验会提前返回）
const f3 = path.join(scans, "ffuf-framework.json");
run("ffuf", f3, () => ({ __writeRaw: JSON.stringify([{ t: 1 }], null, 2), __hits: [], __summary: {}, __summaryText: "z" }), 0);
const c3 = fs.existsSync(f3) ? fs.readFileSync(f3, "utf8") : "";
expect("框架落盘分支未被破坏", c3.includes('"t"'), `实际=${c3.slice(0, 80)}`);

// 分支 4：无 parse 的裸调用仍落盘 stdout（httpx 等默认路径）
const f4 = path.join(scans, "raw-default.json");
run("httpx", f4, undefined, 0);
expect("无 parse 时落盘 stdout（原行为）", fs.existsSync(f4) && fs.readFileSync(f4, "utf8").includes("raw"), "未按原行为落盘");

fs.rmSync(ws, { recursive: true, force: true });
console.log(failed ? `\nFAILED ${failed}` : "\nall persist-ownership tests passed");
process.exit(failed ? 1 : 0);
