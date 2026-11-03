import { randomId } from "./crypto.js";

export const MAX_ID_CHARS = 80;

/**
 * 内容 ID 即 slug：允许字母（含中文等 Unicode 字母）、数字、`.`、`_`、`-`，
 * 80 个字符以内，且首字符必须是字母或数字。
 */
const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

export function normalizeId(raw: string): string {
  return raw.normalize("NFKC").trim();
}

export function isValidId(value: string): boolean {
  const id = normalizeId(value);
  if (!id) return false;
  if ([...id].length > MAX_ID_CHARS) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("\u0000")) return false;
  if (id === "." || id === "..") return false;
  return ID_PATTERN.test(id);
}

export function assertValidId(value: string, label = "ID"): string {
  const id = normalizeId(value);
  if (!isValidId(id)) {
    throw new InvalidIdError(label, id);
  }
  return id;
}

export class InvalidIdError extends Error {
  constructor(readonly label: string, readonly value: string) {
    super(`${label} 不合法：只能包含字母、数字、点、下划线与短横线，且不超过 80 个字符`);
    this.name = "InvalidIdError";
  }
}

/**
 * 由标题生成 slug。中文标题无法音译，因此直接退化为「前缀 + 随机串」，
 * 保证每次新建都能拿到唯一且稳定的 ID（不依赖数据库序列）。
 */
export function slugify(title: string, fallbackPrefix = "note"): string {
  const normalized = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 60);

  if (normalized.length > 0 && /^[\p{L}\p{N}]/u.test(normalized)) return normalized;
  return `${fallbackPrefix}-${randomId(4)}`;
}

export function idPrefixFor(resourceType: "notes" | "essays" | "shelf"): string {
  if (resourceType === "essays") return "essay";
  if (resourceType === "shelf") return "item";
  return "note";
}
