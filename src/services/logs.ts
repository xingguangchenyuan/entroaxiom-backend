import { open, stat } from "node:fs/promises";
import type { AppConfig } from "../config.js";

/**
 * 日志中心的数据层。
 *
 * 三条原则：
 *  1. **只读尾部**：日志文件可能几百 MB，永远只读最后一段，不做全量扫描。
 *  2. **路径来自配置**：能读哪些文件由 `config` 决定，接口只接受逻辑源名（白名单），
 *     绝不把请求里的字符串当文件路径用。
 *  3. **不落库、不改写**：日志是运维事实，后台只做展示与聚合，任何写操作都不在这里。
 */

export type LogKind = "access" | "error" | "app" | "backup";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSource {
  id: string;
  label: string;
  kind: LogKind;
  /** 真实路径只给后端用，接口里不返回（避免把服务器目录结构暴露到浏览器） */
  path: string;
}

export interface LogEntry {
  id: string;
  source: string;
  sourceLabel: string;
  kind: LogKind;
  time: string | null;
  level: LogLevel | null;
  status: number | null;
  method: string | null;
  path: string | null;
  ip: string | null;
  message: string;
  detail: string;
  suspect: boolean;
}

export interface LogQuery {
  source?: string;
  tail: number;
  keyword?: string;
  level?: LogLevel;
  status?: number;
  suspectOnly?: boolean;
}

export interface LogPage {
  items: LogEntry[];
  total: number;
  truncated: boolean;
  generatedAt: string;
  sources: { id: string; label: string; kind: LogKind }[];
}

export interface SecurityBucket {
  key: string;
  count: number;
  lastSeen: string | null;
  sample: string;
}

export interface SecuritySummary {
  hours: number;
  total: number;
  ips: SecurityBucket[];
  paths: SecurityBucket[];
  statuses: SecurityBucket[];
  recent: LogEntry[];
}

export interface CloudflareEvent {
  action: string;
  datetime: string | null;
  clientIP: string | null;
  path: string | null;
  userAgent: string | null;
  ruleId: string | null;
  count: number;
}

export interface CloudflareView {
  configured: boolean;
  note: string;
  hours: number;
  events: CloudflareEvent[];
  totals: { blocked: number; challenged: number; other: number };
}

const MAX_TAIL_BYTES = 512 * 1024;

export function logSources(config: AppConfig): LogSource[] {
  return [
    { id: "nginx-access", label: "Web 访问", kind: "access", path: config.logAccessPath },
    { id: "nginx-error", label: "Web 错误", kind: "error", path: config.logErrorPath },
    { id: "api", label: "程序日志", kind: "app", path: config.logApiPath },
    { id: "backup", label: "备份日志", kind: "backup", path: config.logBackupPath }
  ];
}

/** 扫描器/爆破器常打的路径特征。命中这些路径的请求，一律标记为「疑似攻击」。 */
const SUSPECT_PATH_PATTERNS: RegExp[] = [
  /\.env(\b|\/|$)/i,
  /\/\.git(\/|$)/i,
  /\.php(\?|$|\/)/i,
  /wp-(admin|login|content|includes)/i,
  /phpmyadmin/i,
  /xmlrpc/i,
  /cgi-bin/i,
  /\/etc\/passwd/i,
  /\/shell(\?|$)/i,
  /\/config\.(json|ya?ml)/i
];

/** 这些状态码本身说明有人在敲门。404 不算——正常访问也会 404。 */
const SUSPECT_STATUS = new Set([401, 403, 429, 444]);

export function isSuspectPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return SUSPECT_PATH_PATTERNS.some(re => re.test(path));
}

export function isSuspectStatus(status: number | null | undefined): boolean {
  return status !== null && status !== undefined && SUSPECT_STATUS.has(status);
}

function makeId(source: string, index: number): string {
  return `${source}:${index}`;
}

function clip(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11
};

/** nginx 的时间是 `06/Nov/2026:00:01:52 +0000`，不是 Date 能直接吃的格式。 */
export function parseNginxTime(raw: string): string | null {
  const m = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, day, monName, year, hh, mm, ss, sign, offH, offM] = m;
  const month = MONTHS[monName];
  if (month === undefined) return null;
  const offsetMinutes = (sign === "-" ? -1 : 1) * (Number(offH) * 60 + Number(offM));
  const utc =
    Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)) - offsetMinutes * 60_000;
  if (!Number.isFinite(utc)) return null;
  return new Date(utc).toISOString();
}

function parseNginxDate(raw: string): string | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

const ACCESS_RE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?/;

export function parseAccessLine(line: string, source: LogSource, index: number): LogEntry | null {
  const raw = line.trim();
  if (!raw) return null;
  const m = ACCESS_RE.exec(raw);
  if (!m) return null;
  const [, ip, timeRaw, request, statusRaw, bytes, referer, ua] = m;
  const requestParts = request.split(" ");
  const method = requestParts[0] && requestParts[0] !== "-" ? requestParts[0] : null;
  let reqPath: string | null = requestParts.length > 1 ? requestParts[1] : null;
  if (reqPath === "-") reqPath = null;
  const status = Number(statusRaw);
  const time = parseNginxTime(timeRaw);
  const suspect = isSuspectPath(reqPath) || isSuspectStatus(status);
  return {
    id: makeId(source.id, index),
    source: source.id,
    sourceLabel: source.label,
    kind: source.kind,
    time,
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    status,
    method,
    path: reqPath,
    ip,
    message: `${method ?? "-"} ${reqPath ?? "-"} → ${status}${bytes && bytes !== "-" ? ` · ${bytes}B` : ""}`,
    detail: clip(`${raw}${referer && referer !== "-" ? ` · referer ${referer}` : ""}${ua ? ` · ${ua}` : ""}`),
    suspect
  };
}

const ERROR_RE = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[([a-z]+)\] (.+)$/;

export function parseErrorLine(line: string, source: LogSource, index: number): LogEntry | null {
  const raw = line.trim();
  if (!raw) return null;
  const m = ERROR_RE.exec(raw);
  if (!m) return null;
  const [, timeRaw, levelRaw, messageRaw] = m;
  const level: LogLevel =
    levelRaw === "error" || levelRaw === "crit" || levelRaw === "alert" || levelRaw === "emerg"
      ? "error"
      : levelRaw === "warn"
        ? "warn"
        : levelRaw === "debug"
          ? "debug"
          : "info";
  return {
    id: makeId(source.id, index),
    source: source.id,
    sourceLabel: source.label,
    kind: source.kind,
    time: parseNginxDate(timeRaw),
    level,
    status: null,
    method: null,
    path: null,
    ip: null,
    message: clip(messageRaw, 400),
    detail: clip(raw),
    suspect: false
  };
}

const PINO_LEVELS: Record<number, LogLevel> = {
  10: "debug",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "error"
};

interface PinoRequest {
  method?: string;
  url?: string;
  remoteAddress?: string;
}

interface PinoLine {
  level?: number;
  time?: string | number;
  msg?: string;
  reqId?: string;
  req?: PinoRequest;
  res?: { statusCode?: number };
  responseTime?: number;
  err?: { message?: string; stack?: string };
}

function pinoTime(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 程序日志是 pino 的 JSON 行：一条请求会产生 `incoming request` 与
 * `request completed` 两行，这里按 `reqId` 合并成一条，避免后台列表里
 * 同一个请求出现两次、且第二次没有路径。
 */
/** 已收到 incoming、还没等到 completed 的请求（进程崩溃时这些会留在窗口末尾） */
export interface AppPendingRequest {
  method: string | null;
  url: string | null;
  ip: string | null;
  time: string | null;
}

export function parseAppLine(
  line: string,
  source: LogSource,
  index: number,
  pending: Map<string, AppPendingRequest>
): LogEntry | null {
  const raw = line.trim();
  if (!raw) return null;
  let parsed: PinoLine;
  try {
    parsed = JSON.parse(raw) as PinoLine;
  } catch {
    return {
      id: makeId(source.id, index),
      source: source.id,
      sourceLabel: source.label,
      kind: source.kind,
      time: null,
      level: "info",
      status: null,
      method: null,
      path: null,
      ip: null,
      message: clip(raw, 400),
      detail: clip(raw),
      suspect: false
    };
  }
  const level = parsed.level !== undefined ? (PINO_LEVELS[parsed.level] ?? "info") : "info";
  const time = pinoTime(parsed.time);
  const reqId = parsed.reqId ?? "";

  if (parsed.req) {
    // 一次请求在 api.log 里是两行：incoming + completed。
    // 只登记、不产出记录——否则每条请求都会在界面上出现两次，其中一次永远没有状态码。
    const method = parsed.req.method ?? null;
    const url = parsed.req.url ?? null;
    if (reqId) {
      pending.set(reqId, { method, url, ip: parsed.req.remoteAddress ?? null, time });
    }
    return null;
  }

  if (parsed.res) {
    const status = parsed.res.statusCode ?? null;
    const base = pending.get(reqId);
    if (reqId) pending.delete(reqId);
    const method = base?.method ?? null;
    const url = base?.url ?? null;
    const ip = base?.ip ?? null;
    const elapsed = typeof parsed.responseTime === "number" ? ` · ${parsed.responseTime.toFixed(1)}ms` : "";
    return {
      id: makeId(source.id, index),
      source: source.id,
      sourceLabel: source.label,
      kind: source.kind,
      time: time ?? base?.time ?? null,
      level: level === "info" && status !== null && status >= 500 ? "error" : level,
      status,
      method,
      path: url,
      ip,
      message: `完成 ${method ?? ""} ${url ?? ""} → ${status ?? "-"}${elapsed}`.trim(),
      detail: clip(raw),
      suspect: isSuspectPath(url) || isSuspectStatus(status)
    };
  }

  const messageRaw = parsed.err?.message ?? parsed.msg ?? raw;
  return {
    id: makeId(source.id, index),
    source: source.id,
    sourceLabel: source.label,
    kind: source.kind,
    time,
    level,
    status: null,
    method: null,
    path: null,
    ip: null,
    message: clip(messageRaw, 400),
    detail: clip(parsed.err?.stack ?? raw),
    suspect: false
  };
}

export async function readLogTail(file: string, maxBytes = MAX_TAIL_BYTES): Promise<{ text: string; truncated: boolean }> {
  let info;
  try {
    info = await stat(file);
  } catch {
    // 文件不存在不是错误：本地开发没有 nginx，界面上显示“暂无日志”即可
    return { text: "", truncated: false };
  }
  if (!info.isFile()) return { text: "", truncated: false };
  const length = info.size;
  if (length === 0) return { text: "", truncated: false };
  const start = Math.max(0, length - maxBytes);
  const size = length - start;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, start);
    let text = buffer.toString("utf8");
    // 从中间读会切到半行，丢掉第一段
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return { text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * 窗口末尾那些只写了 incoming、没有对应 completed 的请求（正在处理，或进程被杀）。
 * 不丢掉它们：一个卡住不返回的请求，往往是排查问题的第一条线索。
 */
export function flushPending(
  source: LogSource,
  pending: Map<string, AppPendingRequest>,
  startIndex: number
): LogEntry[] {
  const out: LogEntry[] = [];
  let offset = 0;
  for (const [reqId, item] of pending) {
    out.push({
      id: makeId(source.id, startIndex + offset),
      source: source.id,
      sourceLabel: source.label,
      kind: source.kind,
      time: item.time,
      level: "warn",
      status: null,
      method: item.method,
      path: item.url,
      ip: item.ip,
      message: `未完成 ${item.method ?? ""} ${item.url ?? ""}（${reqId} 没有 completed 记录）`,
      detail: JSON.stringify({ reqId, ...item }),
      suspect: isSuspectPath(item.url)
    });
    offset += 1;
  }
  pending.clear();
  return out;
}

function matchesQuery(entry: LogEntry, query: LogQuery): boolean {
  if (query.level && entry.level !== query.level) return false;
  if (query.status !== undefined && entry.status !== query.status) return false;
  if (query.suspectOnly && !entry.suspect) return false;
  if (query.keyword) {
    const needle = query.keyword.toLowerCase();
    const haystack = `${entry.message} ${entry.detail} ${entry.path ?? ""} ${entry.ip ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export async function listLogs(config: AppConfig, query: LogQuery): Promise<LogPage> {
  const sources = logSources(config);
  const selected =
    query.source && query.source !== "all" ? sources.filter(item => item.id === query.source) : sources;
  if (query.source && query.source !== "all" && selected.length === 0) {
    throw new Error(`未知的日志来源：${query.source}`);
  }

  const entries: LogEntry[] = [];
  let truncated = false;

  for (const source of selected) {
    const { text, truncated: cut } = await readLogTail(source.path);
    if (cut) truncated = true;
    if (!text) continue;
    const lines = text.split("\n");
    const pending = new Map<string, AppPendingRequest>();
    lines.forEach((line, index) => {
      let entry: LogEntry | null = null;
      if (source.kind === "access") entry = parseAccessLine(line, source, index);
      else if (source.kind === "error") entry = parseErrorLine(line, source, index);
      else entry = parseAppLine(line, source, index, pending);
      if (entry) entries.push(entry);
    });
    if (source.kind !== "access" && source.kind !== "error") {
      entries.push(...flushPending(source, pending, lines.length));
    }
  }

  entries.sort((a, b) => {
    const ta = a.time ? Date.parse(a.time) : Number.NaN;
    const tb = b.time ? Date.parse(b.time) : Number.NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });

  const matched = entries.filter(entry => matchesQuery(entry, query));
  const filtered = matched.slice(0, query.tail);

  return {
    items: filtered,
    total: matched.length,
    truncated,
    generatedAt: new Date().toISOString(),
    sources: sources.map(({ id, label, kind }) => ({ id, label, kind }))
  };
}

function bump(map: Map<string, SecurityBucket>, key: string, time: string | null, sample: string): void {
  const current = map.get(key);
  if (current) {
    current.count += 1;
    if (time && (!current.lastSeen || Date.parse(time) > Date.parse(current.lastSeen))) current.lastSeen = time;
  } else {
    map.set(key, { key, count: 1, lastSeen: time, sample });
  }
}

export async function securitySummary(config: AppConfig, hours: number): Promise<SecuritySummary> {
  const since = Date.now() - hours * 3_600_000;
  const sources = logSources(config).filter(item => item.kind === "access" || item.kind === "app");
  const recent: LogEntry[] = [];
  const ips = new Map<string, SecurityBucket>();
  const paths = new Map<string, SecurityBucket>();
  const statuses = new Map<string, SecurityBucket>();
  let total = 0;

  for (const source of sources) {
    const { text } = await readLogTail(source.path);
    if (!text) continue;
    const pending = new Map<string, AppPendingRequest>();
    const lines = text.split("\n");
    const collect = (entry: LogEntry | null) => {
      if (!entry || !entry.suspect) return;
      if (entry.time && Date.parse(entry.time) < since) return;
      total += 1;
      recent.push(entry);
      if (entry.ip) bump(ips, entry.ip, entry.time, entry.message);
      if (entry.path) bump(paths, entry.path, entry.time, entry.message);
      if (entry.status !== null) bump(statuses, String(entry.status), entry.time, entry.message);
    };
    lines.forEach((line, index) => {
      collect(
        source.kind === "access"
          ? parseAccessLine(line, source, index)
          : parseAppLine(line, source, index, pending)
      );
    });
    if (source.kind !== "access") {
      for (const rest of flushPending(source, pending, lines.length)) collect(rest);
    }
  }

  recent.sort((a, b) => {
    const ta = a.time ? Date.parse(a.time) : Number.NaN;
    const tb = b.time ? Date.parse(b.time) : Number.NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });

  const toSorted = (map: Map<string, SecurityBucket>) =>
    [...map.values()].sort((a, b) => b.count - a.count).slice(0, 20);

  return {
    hours,
    total,
    ips: toSorted(ips),
    paths: toSorted(paths),
    statuses: toSorted(statuses),
    recent: recent.slice(0, 100)
  };
}

interface CloudflareCache {
  key: string;
  at: number;
  value: CloudflareView;
}

let cloudflareCache: CloudflareCache | null = null;
const CLOUDFLARE_TTL_MS = 10 * 60 * 1000;

interface GraphQlResponse {
  data?: {
    viewer?: {
      zones?: Array<{
        firewallEventsAdaptive?: Array<{
          action?: string;
          datetime?: string;
          clientIP?: string;
          clientRequestPath?: string;
          userAgent?: string;
          ruleId?: string;
        }>;
      }>;
    };
  };
  errors?: Array<{ message?: string }>;
}

const FIREWALL_QUERY = `query FirewallEvents($zoneTag: String!, $since: Time!, $limit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptive(
        filter: { datetime_geq: $since }
        limit: $limit
        orderBy: [datetime_DESC]
      ) {
        action
        datetime
        clientIP
        clientRequestPath
        userAgent
        ruleId
      }
    }
  }
}`;

/**
 * 从 Cloudflare 拉防火墙事件。
 *
 * 只在服务器上配置了 token 才有结果；本地开发返回 `configured: false`，
 * 界面显示“未配置”而不是伪造数据。结果缓存 10 分钟——这是别人家的 API，
 * 后台刷一次不应该打一次。
 */
export async function fetchCloudflareEvents(config: AppConfig, hours: number): Promise<CloudflareView> {
  const token = config.cloudflareApiToken;
  const zoneId = config.cloudflareZoneId;
  if (!token || !zoneId) {
    return {
      configured: false,
      note: "服务器未配置 Cloudflare 凭据（CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID），拦截记录不可用。",
      hours,
      events: [],
      totals: { blocked: 0, challenged: 0, other: 0 }
    };
  }

  const bucket = Math.floor(Date.now() / CLOUDFLARE_TTL_MS);
  const cacheKey = `${zoneId}:${hours}:${bucket}`;
  if (cloudflareCache && cloudflareCache.key === cacheKey) return cloudflareCache.value;

  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  let response: Response;
  try {
    response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: FIREWALL_QUERY,
        variables: { zoneTag: zoneId, since, limit: 100 }
      }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    return {
      configured: true,
      note: "连接 Cloudflare 失败（网络或凭据问题），请稍后重试。",
      hours,
      events: [],
      totals: { blocked: 0, challenged: 0, other: 0 }
    };
  }

  if (!response.ok) {
    return {
      configured: true,
      note: `Cloudflare 返回 HTTP ${response.status}，请检查 token 权限（需要 Zone · Firewall Services · Read）。`,
      hours,
      events: [],
      totals: { blocked: 0, challenged: 0, other: 0 }
    };
  }

  const payload = (await response.json()) as GraphQlResponse;
  const rows = payload.data?.viewer?.zones?.[0]?.firewallEventsAdaptive ?? [];
  const events: CloudflareEvent[] = rows.map(row => ({
    action: row.action ?? "unknown",
    datetime: row.datetime ?? null,
    clientIP: row.clientIP ?? null,
    path: row.clientRequestPath ?? null,
    userAgent: row.userAgent ?? null,
    ruleId: row.ruleId ?? null,
    count: 1
  }));

  const totals = { blocked: 0, challenged: 0, other: 0 };
  for (const event of events) {
    if (event.action === "block") totals.blocked += 1;
    else if (event.action === "challenge" || event.action === "jschallenge" || event.action === "managed_challenge")
      totals.challenged += 1;
    else totals.other += 1;
  }

  const value: CloudflareView = {
    configured: true,
    note: payload.errors?.length ? `Cloudflare 返回告警：${payload.errors.map(e => e.message ?? "").join("；")}` : "",
    hours,
    events,
    totals
  };
  cloudflareCache = { key: cacheKey, at: Date.now(), value };
  return value;
}
