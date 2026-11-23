# Saker 0.9.21

### ✨ 新增功能

- 新增只读 `tls_probe`：读取 TLS 协议、加密套件、证书主题/签发者/有效期/指纹/SAN/ALPN，不发送 HTTP 请求。
- `crypto-transport-test` 接入真实 TLS 能力，不再因缺少独立 tls 工具被误判为 blocked。

### 🐛 问题修复

- TLS 探测继续要求目标已登记在 `assets.md` / `cloud-assets.md`，不绕过防盲打。
- active-scan 工具包加载后才会出现 `tls_probe`，不增加常驻工具面。

### 🎨 体验优化

- TLS 握手结果写入 `artifacts/scans/tls-*.json` 并回 `evidence-index.md`。
- `dsh-scanner-tools` 升到 `1.2.2`，`dsh-tool-scope` 升到 `0.3.5`，结果插件 `1.4.16`，根包 `0.9.21`。

### ⚠️ 其他变更

- 不改变用户数据、MCP、会话、知识与个人方法；不发布、不 push、不提交 Git。
