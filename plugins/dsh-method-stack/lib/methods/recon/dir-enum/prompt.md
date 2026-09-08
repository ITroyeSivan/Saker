# 目录与敏感文件枚举
1. 先做 WAF/限速画像（HTTP 429/403 分布），再定速率：无防护 ≤12 req/s，有防护 ≤6 req/s 并观察封禁。
2. 用 DSH_TOOL_FFUF（fast）与 DSH_TOOL_DIRSEARCH（深一点）跑字典；命中常见敏感文件优先（.git/HEAD、备份、/api 文档、swagger、spring actuator、.env、/actuator/env、源码泄漏）。
3. 命中即验证：直接请求确认 200 且内容有效；.git 可尝试 dump 还原。
4. 产出登记：scripts/<target>/dir-finds.md；有效入口进攻击面格。
纪律：命中先验证再下结论；不盲目放大扫描范围。