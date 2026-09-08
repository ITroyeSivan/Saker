# 指纹识别
1. 抓首页与常见静态资源（favicon、js 库路径、/robots、报错页），用 DSH_TOOL_HTTPX 批量探测，比对公开指纹库与 favicon hash。
2. 记录：框架/CMS、版本（精确到小版本）、中间件、WAF/网关、语言与反代特征。
3. 版本 → 关联已知 CVE（先在知识库 knowledge_search 查 PATT 对应章节，再考虑 EDB 查 PoC）。
4. 产出：scripts/<target>/fingerprint.md；结果供 exploit 组选择攻击方向。
纪律：指纹只作线索，漏洞必须复现验证后才成立。