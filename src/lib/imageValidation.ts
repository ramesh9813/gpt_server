/**
 * Shared image DataURL validation — single source, imported by chat.service
 * and messages.routes so they can never drift.
 */
import { z } from "zod";
import { MAX_IMAGES, MAX_IMAGE_STRING_LENGTH } from "./constants";

export { MAX_IMAGES, MAX_IMAGE_STRING_LENGTH };

const IMAGE_PREFIX_REGEX =
  /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i;

export const imageDataUrlSchema = z
  .string()
  .max(MAX_IMAGE_STRING_LENGTH, "Each image must be under ~7MB")
  .refine((v) => IMAGE_PREFIX_REGEX.test(v.slice(0, 80)), {
    message: "images must be dataURL jpeg/png/webp/gif base64",
  })
  .refine((v) => v.length > 30, {
    message: "images must contain base64 payload",
  });

export const imagesSchema = z
  .array(imageDataUrlSchema)
  .max(MAX_IMAGES)
  .optional();
