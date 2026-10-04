// Desktop RPC returns immediately; the existing collector owns durable cursors
// and the cross-process lock. This object only tracks the current UI request.
export function createUpdateJob() {
  let job = null;
  return {
    status: () => job ? { ...job } : null,
    start(pipeline, home, collector, source) {
      if (job?.running) throw new Error('正在更新，请等待本轮结束');
      const config = pipeline.normalizeCollectorConfig(collector);
      if (!config.sources.length) throw new Error('请至少选择一个情报源');
      if (source && !config.sources.includes(source)) throw new Error('请先勾选要更新的源');
      const sources = source ? [source] : config.sources;
      if (sources.includes('wechat') && !config.wechatQuery) throw new Error('公众号源需要检索词；也可取消勾选');
      // Persist the exact visible selection before starting, including when
      // scheduled collection is off. Single-source updates retain that selection.
      pipeline.writeCollectorConfig(config, home);
      job = { running: true, sources, startedAt: new Date().toISOString(), error: '', summary: null };
      const current = job;
      Promise.resolve().then(() => pipeline.runCollector({ ...config, sources, force: true, noCache: true }, { home }))
        .then(result => {
          if (result.skipped) throw new Error(result.reason || '更新未启动');
          current.summary = pipeline.collectorResponse(result).summary;
        })
        .catch(error => { current.error = String(error?.message || error); })
        .finally(() => { current.running = false; });
      return { ...current };
    },
  };
}
