import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { v2 as cloudinary } from "cloudinary";
import type { Config } from "../config.js";

export type ImageType = "jpeg" | "png" | "gif" | "webp";

/**
 * Work out what an upload really is from its first bytes. The filename and the
 * Content-Type header are chosen by the client and are not trusted. SVG is
 * deliberately not accepted: it can carry script.
 */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export interface StoredImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface ImageStorage {
  readonly kind: "cloudinary" | "local";
  store(buf: Buffer, type: ImageType): Promise<StoredImage>;
}

class CloudinaryStorage implements ImageStorage {
  readonly kind = "cloudinary";
  constructor(c: NonNullable<Config["cloudinary"]>) {
    cloudinary.config({ cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret, secure: true });
  }
  store(buf: Buffer): Promise<StoredImage> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: "synchat", resource_type: "image" }, (err, result) => {
        if (err || !result) return reject(new Error(err?.message ?? "Cloudinary upload failed"));
        resolve({ url: result.secure_url, width: result.width ?? null, height: result.height ?? null });
      });
      stream.end(buf);
    });
  }
}

/** Development fallback: files on local disk, served from /uploads. */
class LocalStorage implements ImageStorage {
  readonly kind = "local";
  constructor(private readonly dir: string) {}
  async store(buf: Buffer, type: ImageType): Promise<StoredImage> {
    await fs.mkdir(this.dir, { recursive: true });
    // The name is random and never derived from anything the client sent.
    const name = `${randomUUID()}.${type === "jpeg" ? "jpg" : type}`;
    await fs.writeFile(path.join(this.dir, name), buf, { flag: "wx" });
    return { url: `/uploads/${name}`, width: null, height: null };
  }
}

/**
 * Cloudinary when its keys are set. Otherwise local disk, but never in production,
 * where a server's disk is usually temporary: there image upload is simply off.
 */
export function createImageStorage(config: Config): ImageStorage | null {
  if (config.cloudinary) return new CloudinaryStorage(config.cloudinary);
  if (!config.isProd) return new LocalStorage(config.uploadDir);
  return null;
}
