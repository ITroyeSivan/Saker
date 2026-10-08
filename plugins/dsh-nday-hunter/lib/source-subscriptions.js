// User subscriptions are data, never executable adapters or repository instructions.
import { createHash } from 'node:crypto';
import { publicRepository } from './source-git.js';
export function githubRepository(value) {
  let input = String(value ?? '').trim();
  if (input.startsWith('https://')) {
    const url = new URL(input);
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash)
      throw new Error('请填写公开 GitHub 仓库地址');
    input = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  return publicRepository(input.replace(/\.git$/, '')).toLowerCase();
}
export function subscriptionId(repository) {
  return 'repo-' + createHash('sha256').update(githubRepository(repository)).digest('hex').slice(0, 20);
}
export function normalizeSubscriptions(values = []) {
  if (!Array.isArray(values) || values.length > 40) throw new Error('最多订阅 40 个公开仓库');
  const seen = new Set();
  return values.map(value => {
    const repository = githubRepository(value.repository ?? value.url);
    const id = subscriptionId(repository);
    if (seen.has(id)) throw new Error('仓库已订阅');
    seen.add(id);
    if (value.mode !== undefined && !['sync', 'ai'].includes(value.mode)) throw new Error('请选择仅同步或 AI 整理');
    return { id, repository, mode: value.mode ?? 'sync' };
  });
}
export function repositoryDescriptor(subscription) {
  return { repository: subscription.repository, kind: 'research-project', author: subscription.repository.split('/')[0],
    matches: filename => /\.(md|txt|py|go|js|java|yaml|yml|json)$/i.test(filename),
    detail: '用户订阅的公开仓库；来源声明、适用条件与原始作者仍须回源复核。' };
}
