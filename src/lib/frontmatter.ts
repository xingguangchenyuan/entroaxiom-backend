/**
 * 极简 YAML frontmatter：只支持导出/导入实际会用到的子集。
 * - `key: value`（字符串、数字、布尔、null）
 * - `key:` + `- item` 块状数组，或 `key: [a, b]` 行内数组
 * - 单/双引号字符串（双引号按 JSON 转义解析）
 * 未知字段原样保留，由调用方决定提示。
 */
export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  present: boolean;
}

const NEEDS_QUOTES = /^[\s]|[\s]$|[:#\-[\]{}&*!|>'"%@`,?]|^$|^(true|false|null|yes|no|on|off|~)$/i;

export function quoteScalar(value: string): string {
  if (value === "") return '""';
  if (NEEDS_QUOTES.test(value) || /[\n\r\t]/.test(value)) return JSON.stringify(value);
  return value;
}

export function buildFrontmatter(fields: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${quoteScalar(String(item))}`);
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    const text = String(value);
    if (text === "") continue;
    lines.push(`${key}: ${quoteScalar(text)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function stripQuotes(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function coerce(raw: string): unknown {
  const value = raw.trim();
  if (value === "" || value === "~" || /^null$/i.test(value)) return null;
  if (/^(true|yes|on)$/i.test(value)) return true;
  if (/^(false|no|off)$/i.test(value)) return false;
  if (/^-?\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map(item => stripQuotes(item))
      .filter(item => item.length > 0);
  }
  return stripQuotes(value);
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { data: {}, body: normalized, present: false };
  }
  const lines = normalized.split("\n");
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return { data: {}, body: normalized, present: false };
  }

  const data: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      const list = (data[currentListKey] as unknown[]) ?? [];
      list.push(coerce(listItem[1]));
      data[currentListKey] = list;
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rest] = pair;
    if (rest.trim() === "") {
      currentListKey = key;
      data[key] = [];
      continue;
    }
    currentListKey = null;
    data[key] = coerce(rest);
  }

  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  return { data, body, present: true };
}

export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const parsed = parseFrontmatter(raw);
  if (!parsed.present) return { frontmatter: null, body: parsed.body };
  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---", 4);
  const frontmatter = end === -1 ? null : normalized.slice(0, end + 4);
  return { frontmatter, body: parsed.body };
}
