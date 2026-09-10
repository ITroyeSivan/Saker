1. 拉取首屏 HTML，收集全部 <script src>；SPA 用浏览器通道（browser-recon 技能）取异步 chunk。
2. 正则提取：接口路径(/api/...)、路由表、参数名、密钥硬编码线索、注释里的测试入口。
3. 按方法+路径+入参+鉴权要求整理成 scripts/<target>/api-endpoints.md。
4. 把"纯 API 型"目标交给攻击组（无页面直接打 API）。
边界：仅做无害最小验证。
