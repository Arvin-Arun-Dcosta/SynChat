import type { ErrorRequestHandler, RequestHandler } from "express";
import { z } from "zod";

/** An error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Not signed in") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Not allowed") => new HttpError(403, "forbidden", message);
// Used for "does not exist" and for "exists but you are not a member" alike, so a
// non-member cannot tell whether a conversation or message id is real.
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, "conflict", message, details);

/** Validate untrusted input. Throws a 400 listing what was wrong. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest("Invalid input", z.flattenError(result.error));
  }
  return result.data;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound("No such endpoint"));

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Errors raised by Express middleware (body parser, multer) carry a 4xx status.
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
  const type = (err as { type?: string }).type;
  if (type === "entity.too.large") {
    res.status(413).json({ error: { code: "too_large", message: "Request body is too large" } });
    return;
  }
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "bad_request", message: "Malformed JSON" } });
    return;
  }
  if ((err as { name?: string }).name === "MulterError") {
    const tooBig = (err as { code?: string }).code === "LIMIT_FILE_SIZE";
    res
      .status(tooBig ? 413 : 400)
      .json({ error: { code: tooBig ? "too_large" : "bad_request", message: tooBig ? "File is too large" : "Invalid upload" } });
    return;
  }
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: "bad_request", message: "Bad request" } });
    return;
  }
  console.error("[http] unhandled error:", err);
  res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
};
