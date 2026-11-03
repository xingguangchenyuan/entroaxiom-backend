import type { FastifyRequest } from "fastify";
import { errors } from "./errors.js";

/** 一次 multipart 请求解析后的结果：普通字段按名收集，文件单独放。 */
export interface MultipartFile {
  fieldName: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MultipartPayload {
  fields: Map<string, string>;
  file: MultipartFile | null;
}

/**
 * 顺序无关地解析 multipart。
 *
 * 为什么必须这样写：`request.file()` 只保证"把文件流交给调用方"，busboy 在收到文件
 * 之后才会继续解析后续字段；如果先读 `part.fields.visibility` 再 `toBuffer()`，
 * 字段是否已经到齐完全取决于客户端 append 顺序和单块缓冲大小（实测约 64KB 分界），
 * 大文件必然读不到后置字段——于是上传被静默降级成 private、导入因 type 丢失被拒。
 * 这里改成把整条流走完：字段收集到 Map，文件当即读入内存，最后由调用方统一校验。
 */
export async function readMultipart(
  request: FastifyRequest,
  options: { fileLabel?: string } = {}
): Promise<MultipartPayload> {
  const fileLabel = options.fileLabel ?? "file";
  const fields = new Map<string, string>();
  let file: MultipartFile | null = null;

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (file) {
        // 多传的文件也要读完，否则连接会悬挂在 busboy 上。
        await part.toBuffer();
        throw errors.validation([
          { loc: ["body", fileLabel], msg: `一次只能上传一个文件（收到了 ${part.fieldname}）` }
        ]);
      }
      if (part.fieldname !== fileLabel) {
        await part.toBuffer();
        throw errors.validation([{ loc: ["body", fileLabel], msg: `文件字段名必须是 ${fileLabel}` }]);
      }
      file = {
        fieldName: part.fieldname,
        filename: part.filename ?? "",
        mimeType: part.mimetype ?? "application/octet-stream",
        data: await part.toBuffer()
      };
      continue;
    }

    const value = (part as { value?: unknown }).value;
    if (typeof value === "string") fields.set(part.fieldname, value);
    else if (value !== undefined && value !== null) fields.set(part.fieldname, String(value));
  }

  return { fields, file };
}

/** 取一个已 trim 的普通字段；空串按"没传"处理，避免前端把空输入框发上来。 */
export function fieldValue(payload: MultipartPayload, name: string): string | null {
  const raw = payload.fields.get(name);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `visibility` 字段：缺省/空串 = private；只接受 public / private；
 * 其它值必须报验证错误——静默改成 private 会让用户以为上传成了公开图片。
 */
export function visibilityField(payload: MultipartPayload, name = "visibility"): "public" | "private" {
  const raw = payload.fields.get(name);
  if (raw === undefined) return "private";
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return "private";
  if (value === "public" || value === "private") return value;
  throw errors.validation([{ loc: ["body", name], msg: `${name} 只能是 public 或 private` }]);
}
