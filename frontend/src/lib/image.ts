export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const IMAGE_ACCEPT = ACCEPTED.join(",");

export interface PickedImage {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

/** Check a chosen file and measure it. Throws a readable message if it cannot be sent. */
export async function prepareImage(file: File): Promise<PickedImage> {
  if (!ACCEPTED.includes(file.type)) throw new Error("Only JPEG, PNG, GIF or WebP images can be sent");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("That image is larger than 5 MB");
  const previewUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = previewUrl;
    await img.decode();
    return { file, previewUrl, width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    URL.revokeObjectURL(previewUrl);
    throw new Error("That file could not be read as an image");
  }
}
