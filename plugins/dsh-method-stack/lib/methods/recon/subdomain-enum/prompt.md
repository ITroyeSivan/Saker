1. 用 DSH_TOOL_SUBFINDER 等枚举子域；合并证书透明日志（crt.sh 等）与字典爆破结果，去重。
2. DSH_TOOL_HTTPX 批量探活：状态/标题/技术栈/重定向，筛出非标准端口与独立 IP。
3. 高价值目标：dev/stage/test/admin/api/内部命名子域、泛解析；检查子域接管条件（悬空 CNAME/NS）。
4. 产出 scripts/<target>/subdomains.md（含工具与时间）；存活面进入攻击面台账。
关联 PATT：PayloadsAllTheThings/Virtual Hosts（接管）、Account Takeover。
边界：仅做无害最小验证。
