1. 用 DSH_TOOL_NMAP（或 fscan）对目标做扫描；外网目标优先常用端口+top1000，内网目标再扩全端口。
2. 每个开放端口记录：端口/协议/服务/版本（可 banner 或指纹确认）。
3. 产出登记：写 scripts/<target>/port-scan.md（含命令与时间）；服务进 attack-atlas 对应攻击面格子（已测有发现/未命中）。
4. 若目标有 Web 服务，把端口+路径线索交给 JS/API 盘点与指纹识别方法衔接。
纪律：有 WAF/CDN 目标先降速；只对授权范围 IP/段执行。
