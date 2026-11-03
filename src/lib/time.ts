const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function addHours(base: Date, hours: number): Date {
  return new Date(base.getTime() + hours * 3600_000);
}

export function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

/** 统一输出带时区标识的 ISO 8601（UTC `Z` 也是合法偏移）。 */
export function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * 取本地日历日。不能用 toISOString().slice(0,10)：那是 UTC 日期，
 * 东八区 00:00–08:00 之间创建的内容会被写成前一天。
 */
function localDateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 只保留日期的接口字段统一输出 `YYYY-MM-DD`。 */
export function toDateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return localDateOnly(value);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (DATE_ONLY.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : localDateOnly(parsed);
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

export function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function secondsUntil(target: Date, from: Date = new Date()): number {
  return Math.max(0, Math.ceil((target.getTime() - from.getTime()) / 1000));
}
