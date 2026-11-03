import { errors, type FieldError } from "./errors.js";

export type { FieldError };

export interface StringOptions {
  required?: boolean;
  nullable?: boolean;
  trim?: boolean;
  min?: number;
  max?: number;
  /** 按 Unicode 码点计数（中文一个字算 1），默认 true */
  codepoints?: boolean;
  default?: string | null;
  label?: string;
  pattern?: RegExp;
  patternMessage?: string;
}

export interface IntOptions {
  required?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  default?: number;
  label?: string;
}

export interface BoolOptions {
  required?: boolean;
  default?: boolean;
  label?: string;
}

export interface EnumOptions {
  required?: boolean;
  nullable?: boolean;
  default?: string | null;
  label?: string;
}

export function charLength(value: string): number {
  return [...value].length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 请求体/查询参数读取器：一次性收集所有字段错误，最后 `finish()` 抛出
 * FastAPI 风格的 `VALIDATION_ERROR`（`details: [{loc, msg}]`）。
 */
export class Input {
  readonly errors: FieldError[] = [];
  private readonly source: Record<string, unknown>;
  private readonly at: Array<string | number>;

  constructor(source: unknown, at: Array<string | number> = ["body"]) {
    if (!isPlainObject(source)) {
      throw errors.validation([{ loc: [...at], msg: "请求体必须是 JSON 对象" }]);
    }
    this.source = source;
    this.at = at;
  }

  has(name: string): boolean {
    const value = this.source[name];
    return value !== undefined && value !== null && value !== "";
  }

  raw(name: string): unknown {
    return this.source[name];
  }

  sourceObject(): Record<string, unknown> {
    return this.source;
  }

  private fail(name: string, msg: string): null {
    this.errors.push({ loc: [...this.at, name], msg });
    return null;
  }

  private label(name: string, label?: string): string {
    return label ?? name;
  }

  str(name: string, options: StringOptions = {}): string | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`);
      if (options.default !== undefined) return options.default;
      return null;
    }
    if (typeof raw !== "string") return this.fail(name, `${label}必须是字符串`);
    const value = options.trim === false ? raw : raw.trim();
    if (value.length === 0) {
      if (options.required) return this.fail(name, `${label}不能为空`);
      if (options.default !== undefined) return options.default;
      return null;
    }
    const length = options.codepoints === false ? value.length : charLength(value);
    if (options.min !== undefined && length < options.min) {
      return this.fail(name, `${label}至少需要 ${options.min} 个字符`);
    }
    if (options.max !== undefined && length > options.max) {
      return this.fail(name, `${label}不能超过 ${options.max} 个字符`);
    }
    if (options.pattern && !options.pattern.test(value)) {
      return this.fail(name, options.patternMessage ?? `${label}格式不正确`);
    }
    return value;
  }

  bool(name: string, options: BoolOptions = {}): boolean | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`) as unknown as null;
      return options.default ?? null;
    }
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return this.fail(name, `${label}必须是布尔值`) as unknown as null;
  }

  int(name: string, options: IntOptions = {}): number | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`) as unknown as null;
      return options.default ?? null;
    }
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return this.fail(name, `${label}必须是整数`) as unknown as null;
    }
    if (options.min !== undefined && value < options.min) {
      return this.fail(name, `${label}不能小于 ${options.min}`) as unknown as null;
    }
    if (options.max !== undefined && value > options.max) {
      return this.fail(name, `${label}不能大于 ${options.max}`) as unknown as null;
    }
    return value;
  }

  float(name: string, options: { required?: boolean; min?: number; max?: number; default?: number; label?: string } = {}): number | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`) as unknown as null;
      return options.default ?? null;
    }
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(value)) return this.fail(name, `${label}必须是数字`) as unknown as null;
    if (options.min !== undefined && value < options.min) {
      return this.fail(name, `${label}不能小于 ${options.min}`) as unknown as null;
    }
    if (options.max !== undefined && value > options.max) {
      return this.fail(name, `${label}不能大于 ${options.max}`) as unknown as null;
    }
    return value;
  }

  oneOf(name: string, allowed: readonly string[], options: EnumOptions = {}): string | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`);
      if (options.default !== undefined) return options.default;
      return null;
    }
    if (typeof raw !== "string" || !allowed.includes(raw)) {
      return this.fail(name, `${label}必须是 ${allowed.join(" / ")} 之一`);
    }
    return raw;
  }

  dateOnly(name: string, options: { required?: boolean; label?: string; default?: string | null } = {}): string | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`);
      return options.default ?? null;
    }
    if (typeof raw !== "string") return this.fail(name, `${label}必须是 YYYY-MM-DD 格式`);
    const value = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealDate(value)) {
      return this.fail(name, `${label}必须是合法的日期（YYYY-MM-DD）`);
    }
    return value;
  }

  httpUrl(name: string, options: { required?: boolean; label?: string; nullable?: boolean; max?: number } = {}): string | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`);
      return null;
    }
    if (typeof raw !== "string") return this.fail(name, `${label}必须是字符串`);
    const value = raw.trim();
    if (options.max !== undefined && charLength(value) > options.max) {
      return this.fail(name, `${label}不能超过 ${options.max} 个字符`);
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    } catch {
      return this.fail(name, `${label}必须是 http(s) 链接`);
    }
    return value;
  }

  strArray(
    name: string,
    options: { required?: boolean; maxItems?: number; maxLength?: number; label?: string } = {}
  ): string[] | null {
    const label = this.label(name, options.label);
    const raw = this.source[name];
    if (raw === undefined || raw === null || raw === "") {
      if (options.required) return this.fail(name, `${label}不能为空`) as unknown as null;
      return null;
    }
    if (!Array.isArray(raw)) return this.fail(name, `${label}必须是字符串数组`) as unknown as null;
    const result: string[] = [];
    for (const [index, item] of raw.entries()) {
      if (typeof item !== "string") {
        this.errors.push({ loc: [...this.at, name, index], msg: `${label}第 ${index + 1} 项必须是字符串` });
        continue;
      }
      const value = item.trim();
      if (value.length === 0) continue;
      if (options.maxLength !== undefined && charLength(value) > options.maxLength) {
        this.errors.push({
          loc: [...this.at, name, index],
          msg: `${label}第 ${index + 1} 项不能超过 ${options.maxLength} 个字符`
        });
        continue;
      }
      result.push(value);
    }
    if (options.maxItems !== undefined && result.length > options.maxItems) {
      this.errors.push({ loc: [...this.at, name], msg: `${label}最多 ${options.maxItems} 项` });
    }
    return result;
  }

  nested(name: string, required = true): Input | null {
    const raw = this.source[name];
    if (raw === undefined || raw === null) {
      if (required) {
        this.errors.push({ loc: [...this.at, name], msg: "缺少必填字段" });
      }
      return null;
    }
    if (!isPlainObject(raw)) {
      this.errors.push({ loc: [...this.at, name], msg: "必须是对象" });
      return null;
    }
    return new Input(raw, [...this.at, name]);
  }

  child(input: Input | null): void {
    if (input && input.errors.length > 0) this.errors.push(...input.errors);
  }

  finish(): void {
    if (this.errors.length > 0) throw errors.validation(this.errors);
  }
}

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(part => Number.parseInt(part, 10));
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 校验路径参数里的 ID（文章 slug / 文件 id / uuid）。 */
export function pathId(value: string | undefined, label = "ID"): string {
  const raw = (value ?? "").trim();
  if (!raw) throw errors.validation([{ loc: ["path", "id"], msg: `${label}不能为空` }]);
  if (charLength(raw) > 120) throw errors.validation([{ loc: ["path", "id"], msg: `${label}过长` }]);
  return raw;
}

/** 解析 `If-Match: 7`（十进制、无引号）。 */
export function parseIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = (raw ?? "").trim().replace(/^"(.*)"$/, "$1");
  if (!/^\d+$/.test(value)) {
    throw errors.badRequest(
      "VALIDATION_ERROR",
      "缺少或非法的 If-Match 头：删除操作必须带上当前 revision（十进制、不带引号）",
      [{ loc: ["headers", "if-match"], msg: "必须是当前 revision 的十进制表示" }]
    );
  }
  return Number.parseInt(value, 10);
}

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

/** 分页参数固定用 snake_case：`page` / `page_size`（与后台客户端一致）。 */
export function parsePaging(query: Record<string, unknown>, defaultSize = 20, maxSize = 100): PageParams {
  const pageRaw = query.page ?? query.pageSize ?? undefined;
  const sizeRaw = query.page_size ?? query.pageSize ?? undefined;
  const toPositive = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  };
  const page = toPositive(pageRaw, 1);
  const pageSize = Math.min(toPositive(sizeRaw, defaultSize), maxSize);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function queryString(query: Record<string, unknown>, name: string): string | undefined {
  const raw = query[name];
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value.length > 0 ? value : undefined;
}

export function queryBool(query: Record<string, unknown>, name: string): boolean | undefined {
  const value = queryString(query, name);
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}
