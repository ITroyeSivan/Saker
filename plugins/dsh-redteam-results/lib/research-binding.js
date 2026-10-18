// 研究方向绑定摘要：基线的 id/版本/端点/身份与 request/response/inputs 原文共同成摘要。
// 单独一层是为了让 task-context 的保存守卫与 research 的校验用同一口径（避免循环依赖）。
import { createHash } from 'node:crypto';

export const baselineHash = row => createHash('sha256')
  .update(JSON.stringify([row.id, row.revision, row.endpoint, row.authContext, row.request, row.response, row.inputs]))
  .digest('hex');
