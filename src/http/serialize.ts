/** 统一的序列化助手：Date → ISO 8601，date 列 → `YYYY-MM-DD`，空值 → null。 */

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function dateOnly(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // 用本地日期分量而不是 toISOString()：后者按 UTC 取，会把东八区的零点退到前一天。
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value.slice(0, 10);
}

export function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function boolOrNull(value: boolean | null | undefined): boolean | null {
  return value === null || value === undefined ? null : value;
}

/** 公开文件地址只有一种形状；物理文件名（storage_key）不对外暴露。 */
export function publicUrlFor(file: { id: string; ext: string }): string {
  return `/uploads/public/${file.id}.${file.ext}`;
}

export function tagsOrNull(value: string[] | null | undefined): string[] | null {
  if (!value || value.length === 0) return null;
  return value;
}
