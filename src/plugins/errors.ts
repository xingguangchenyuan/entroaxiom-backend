import type { FastifyInstance } from "fastify";
import { AppError } from "../http/errors.js";

interface FastifyLikeError {
  code?: string;
  statusCode?: number;
  validation?: Array<{ instancePath?: string; params?: Record<string, unknown>; message?: string }>;
  message?: string;
}

function fieldDetails(error: FastifyLikeError) {
  const list = error.validation ?? [];
  return list.map(item => {
    const instancePath = item.instancePath ?? "";
    const missing = typeof item.params?.missingProperty === "string" ? item.params.missingProperty : null;
    const loc = instancePath
      ? ["body", ...instancePath.split("/").filter(Boolean)]
      : missing
        ? ["body", missing]
        : ["body"];
    return { loc, msg: item.message ?? "参数不合法" };
  });
}

/**
 * 统一错误信封：业务错误原样翻译，框架错误映射成同一套错误码。
 * 失败永远不会以 HTTP 200 返回，也不会把堆栈发给客户端。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        success: false,
        data: error.payload ?? null,
        error: { code: error.code, message: error.message, details: error.details ?? null }
      });
    }

    const shaped = error as unknown as FastifyLikeError;
    const status = shaped.statusCode ?? 500;
    const rawCode = shaped.code ?? "";

    if (rawCode === "FST_FILES_LIMIT" || rawCode === "FST_PARTS_LIMIT" || rawCode === "FST_FIELDS_LIMIT") {
      return reply.code(422).send({
        success: false,
        data: null,
        error: {
          code: "VALIDATION_ERROR",
          message: "上传附带的文件或字段数量超过上限",
          details: null
        }
      });
    }
    if (rawCode === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: "VALIDATION_ERROR", message: "请使用 multipart/form-data 上传文件", details: null }
      });
    }
    if (rawCode === "FST_ERR_CTP_BODY_TOO_LARGE" || rawCode === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({
        success: false,
        data: null,
        error: { code: "FILE_TOO_LARGE", message: "上传内容超过大小上限", details: null }
      });
    }
    if (rawCode === "FST_ERR_CTP_INVALID_JSON_BODY" || rawCode === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return reply.code(400).send({
        success: false,
        data: null,
        error: { code: "VALIDATION_ERROR", message: "请求体不是合法的 JSON", details: null }
      });
    }
    if (Array.isArray(shaped.validation) && shaped.validation.length > 0) {
      return reply.code(422).send({
        success: false,
        data: null,
        error: { code: "VALIDATION_ERROR", message: "请求参数不合法", details: fieldDetails(shaped) }
      });
    }
    if (status === 413) {
      return reply.code(413).send({
        success: false,
        data: null,
        error: { code: "FILE_TOO_LARGE", message: "上传内容超过大小上限", details: null }
      });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        success: false,
        data: null,
        error: { code: "VALIDATION_ERROR", message: shaped.message ?? "请求不合法", details: null }
      });
    }

    request.log.error({ err: error }, "未处理的服务端错误");
    return reply.code(500).send({
      success: false,
      data: null,
      error: { code: "INTERNAL_ERROR", message: "服务器内部错误", details: null }
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      data: null,
      error: { code: "NOT_FOUND", message: "接口不存在", details: null }
    });
  });
}

