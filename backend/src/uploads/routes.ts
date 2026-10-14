import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { HttpError, badRequest, parse } from "../http/errors.js";
import { limiter, me, requireAuth } from "../http/middleware.js";
import { sniffImage, type StoredImage } from "./storage.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const dims = z.object({
  width: z.coerce.number().int().min(1).max(20_000).optional(),
  height: z.coerce.number().int().min(1).max(20_000).optional(),
});

/** Parses one multipart file field into memory, capped at MAX_IMAGE_BYTES. */
export const imageField: RequestHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 4 },
}).single("image");

/** Validate and store the image on this request. Width/height are layout hints only. */
export async function storeUploadedImage(ctx: Ctx, req: Request): Promise<StoredImage & { bytes: number }> {
  if (!ctx.images) throw new HttpError(503, "uploads_disabled", "Image upload is not configured on this server");
  const file = req.file;
  if (!file) throw badRequest("Attach an image in the 'image' field");
  const type = sniffImage(file.buffer);
  if (!type) throw badRequest("Only JPEG, PNG, GIF or WebP images are accepted");
  const hint = parse(dims, req.body ?? {});
  const stored = await ctx.images.store(file.buffer, type);
  return { url: stored.url, width: stored.width ?? hint.width ?? null, height: stored.height ?? hint.height ?? null, bytes: file.size };
}

export function uploadRoutes(ctx: Ctx): Router {
  const r = Router();
  r.use(requireAuth(ctx));
  const uploadLimit = limiter(ctx, { windowMs: 60 * 1000, limit: 20, by: "user" });

  /** Upload an image to attach to a message. Returns an id to send as `imageId`. */
  r.post("/image", uploadLimit, imageField, async (req, res) => {
    const image = await storeUploadedImage(ctx, req);
    const { rows } = await ctx.db.query(
      "INSERT INTO uploads (user_id, url, width, height, bytes) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [me(req).id, image.url, image.width, image.height, image.bytes],
    );
    res.status(201).json({ upload: { id: rows[0]!.id, url: image.url, width: image.width, height: image.height } });
  });

  return r;
}
