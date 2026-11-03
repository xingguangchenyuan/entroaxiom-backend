/** 进程内滑动窗口限流：单进程部署足够用，重启后清零（文档里如实说明）。 */
export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** 键的硬上限：留言限流的键带内容指纹，不设上限就会被大量不同内容撑爆内存。 */
  private static readonly MAX_KEYS = 20_000;
  /** 超过这个时长没再出现的键，直接当成过期清掉。 */
  private static readonly SWEEP_AFTER_MS = 3_600_000;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private prune(key: string, windowMs: number): number[] {
    const cutoff = this.now() - windowMs;
    const list = (this.hits.get(key) ?? []).filter(stamp => stamp > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  check(key: string, limit: number, windowMs: number): LimitResult {
    const list = this.prune(key, windowMs);
    if (list.length < limit) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = list[0] ?? this.now();
    const retry = Math.max(1, Math.ceil((oldest + windowMs - this.now()) / 1000));
    return { allowed: false, retryAfterSeconds: retry };
  }

  record(key: string): void {
    const list = this.hits.get(key) ?? [];
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > RateLimiter.MAX_KEYS) this.evict();
  }

  /**
   * 超限时先清掉一小时没再出现的键，仍超限则按"最后一次命中时间"淘汰最旧的键。
   * 被淘汰的键等于配额清零，这是有意取舍：宁可让极端攻击者多拿一次机会，
   * 也不让单进程被无界 Map 拖到 OOM。
   */
  private evict(): void {
    const staleBefore = this.now() - RateLimiter.SWEEP_AFTER_MS;
    for (const [key, list] of this.hits) {
      if ((list[list.length - 1] ?? 0) <= staleBefore) this.hits.delete(key);
    }
    if (this.hits.size <= RateLimiter.MAX_KEYS) return;
    const ordered = [...this.hits.entries()].sort(
      (a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0)
    );
    for (const [key] of ordered) {
      this.hits.delete(key);
      if (this.hits.size <= RateLimiter.MAX_KEYS) break;
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  size(): number {
    return this.hits.size;
  }
}

export const loginLimiter = new RateLimiter();
export const guestbookLimiter = new RateLimiter();
