// "同一端点"的共享判定：origin + pathname 相同即可，查询参数允许不同。
// J11b 实测：受控对照/观察必须能改查询参数（q=apple vs q=apple'），用 endpoint 整串
// 相等比较会把输入处理类对照全部挡死；路径、来源与身份仍是硬约束（报文解析另有
// origin+pathname 与 Host 校验）。
export function sameEndpointPath(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch { return false; }
}
