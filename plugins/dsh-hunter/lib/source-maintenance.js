// Uses the official host LLM service and its configured default model. No credentials are copied.
import { randomUUID } from 'node:crypto';
export function createSourceMaintenance(ctx, home, load, { refreshIndex = async () => {
  const knowledge = await import('@dsh-external/dsh-knowledge-hub'); return knowledge.dispatch('index-rebuild', {});
} } = {}) {
  let job = null, running = false, disposed = false, controller;
  async function interpret(prompt) {
    const llm = ctx.llm ?? ctx.get?.('llm');
    const defaults = ctx.agentDefaultModel ?? ctx.get?.('agentDefaultModel');
    const route = defaults?.currentSelection?.();
    if (!llm || !route?.provider || !route?.model) throw new Error('请先在模型设置中选择默认模型');
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('AI 整理超时')), 90000);
    let text = '', usage = null, finish;
    try {
      const info = await llm.resolveModelInfo?.(route.provider, route.model, controller.signal);
      const effort = info?.reasoning?.efforts?.find(item => item.id === 'off');
      for await (const chunk of llm.stream({ ...route, ...(effort ? { reasoningEffort: effort.id } : {}), system: prompt.system,
        messages: [{ id: randomUUID(), role: 'user', source: { kind: 'saker-source-review' }, content: [{ type: 'text', text: prompt.input }] }],
        tools: [], maxTokens: 3500, signal: controller.signal })) {
        controller.signal.throwIfAborted();
        if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) throw new Error('AI 整理不允许工具调用');
        if (chunk.type === 'text-delta') text += chunk.text;
        if (text.length > 24000) throw new Error('AI 输出超过限额');
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') finish = chunk.reason;
      }
      controller.signal.throwIfAborted();
      if (finish?.kind !== 'stop') throw new Error('AI 输出未完整结束：' + String(finish?.kind));
      return { text, usage, provider: route.provider, model: route.model };
    } catch (error) {
      error.reviewReceipt = { provider: route.provider, model: route.model, usage };
      if (controller.signal.aborted) throw new Error('AI 整理超时或宿主关闭，进度保留');
      // Provider diagnostics can contain private endpoint details. Expose only the stable failure code.
      if (error.code) throw new Error('AI 整理模型请求失败：' + String(error.code).slice(0, 80));
      throw error;
    } finally { clearTimeout(timer); controller = null; }
  }
  async function review(config, retry = false) {
    if (running || disposed) return { skipped: true, reason: '维护任务已在运行或宿主关闭' };
    running = true; job = { running: true, startedAt: new Date().toISOString(), error: '', result: null };
    try {
      const { reviews } = await load();
      const result = await reviews.runSourceReviews(config, { home, review: interpret, retry });
      job.result = result;
      if (result.published) {
        try { await refreshIndex(); }
        catch { job.indexWarning = '条目已保存，知识索引刷新失败；可在知识库重建索引'; }
      }
      return result;
    } catch (error) { job.error = String(error.message || error); throw error; }
    finally { running = false; job.running = false; }
  }
  return {
    status: () => job ? { ...job } : null,
    review,
    start(config) {
      if (running || disposed) throw new Error('AI 整理正在运行');
      // Publish admission synchronously so repeated UI clicks cannot enqueue a second job.
      const promise = review(config, true);
      promise.catch(() => undefined); // The visible job carries the failure.
      return { ...job };
    },
    async tick() {
      if (running || disposed) return;
      const { pipeline } = await load();
      const config = pipeline.readCollectorConfig(home);
      if (!config.enabled) return;
      await pipeline.runCollectorIfDue({}, { home });
      await review(pipeline.readCollectorConfig(home));
    },
    stop() { disposed = true; controller?.abort(new Error('host disposed')); },
  };
}
