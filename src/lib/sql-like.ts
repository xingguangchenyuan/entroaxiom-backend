/**
 * 把用户输入变成 LIKE 字面量：`%`、`_` 和转义符本身都必须转义，
 * 否则搜 "50%" 会变成"以 50 开头"的通配匹配。
 * PostgreSQL 的 LIKE 默认转义符就是反斜杠，因此不需要显式 ESCAPE 子句。
 */
export function likePattern(keyword: string): string {
  const escaped = keyword.replace(/[\\%_]/g, char => `\\${char}`);
  return `%${escaped}%`;
}
