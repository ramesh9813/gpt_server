import { Router } from "express";
import { z } from "zod";
import { MAX_FILE_NAME_LENGTH, MAX_FILE_SIZE } from "../../lib/constants";
import { logger } from "../../lib/logger";
import {
  buildStorageKey,
  deleteObject,
  getObjectUrl,
  isObjectStorageConfigured,
  parseDataUrl,
  uploadObject
} from "../../lib/objectStorage";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";

const router = Router();

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(MAX_FILE_NAME_LENGTH),
  mime: z.string().trim().min(1).max(128),
  size: z.number().int().min(0).max(MAX_FILE_SIZE),
  dataUrl: z.string().min(1).max(30_000_000)
});

router.post("/upload", requireAuth, validateBody(uploadSchema), async (req, res) => {
  if (!isObjectStorageConfigured) {
    return res.status(503).json({
      success: false,
      error: {
        code: "STORAGE_NOT_CONFIGURED",
        message: "File storage is not configured on the server."
      }
    });
  }

  const { name, mime, size, dataUrl } = req.body as z.infer<typeof uploadSchema>;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_FILE", message: "File payload must be a base64 data URL." }
    });
  }
  if (parsed.buffer.length > MAX_FILE_SIZE) {
    return res.status(413).json({
      success: false,
      error: { code: "FILE_TOO_LARGE", message: `Files must be ${MAX_FILE_SIZE / (1024 * 1024)}MB or smaller.` }
    });
  }

  const contentType = mime === "application/octet-stream" ? parsed.mime : mime;
  const storageKey = buildStorageKey(req.user!.id, name);

  try {
    await uploadObject({ key: storageKey, body: parsed.buffer, contentType });
  } catch (err) {
    logger.error({ err, storageKey }, "Object storage upload failed");
    return res.status(502).json({
      success: false,
      error: { code: "STORAGE_ERROR", message: "Could not save the file to storage." }
    });
  }

  let attachment;
  try {
    attachment = await prisma.attachment.create({
      data: {
        userId: req.user!.id,
        name,
        mime: contentType,
        size: parsed.buffer.length || size,
        storageKey
      }
    });
  } catch (err) {
    logger.error({ err, storageKey }, "Attachment row create failed");
    void deleteObject(storageKey).catch(() => undefined);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Could not save file metadata." }
    });
  }

  return res.status(201).json({
    success: true,
    data: {
      attachment: {
        id: attachment.id,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size
      }
    }
  });
});

router.delete("/:id", requireAuth, async (req, res) => {
  if (!isObjectStorageConfigured) {
    return res.status(503).json({
      success: false,
      error: {
        code: "STORAGE_NOT_CONFIGURED",
        message: "File storage is not configured on the server."
      }
    });
  }

  const attachment = await prisma.attachment.findFirst({
    where: { id: req.params.id, userId: req.user!.id }
  });
  if (!attachment) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "File not found." }
    });
  }
  if (attachment.messageId) {
    return res.status(409).json({
      success: false,
      error: { code: "ALREADY_SENT", message: "Sent attachments cannot be removed." }
    });
  }

  try {
    await deleteObject(attachment.storageKey);
  } catch (err) {
    logger.error({ err, attachmentId: attachment.id }, "Object storage delete failed");
  }
  await prisma.attachment.delete({ where: { id: attachment.id } });
  return res.json({ success: true, data: null });
});

router.get("/:id/url", requireAuth, async (req, res) => {
  if (!isObjectStorageConfigured) {
    return res.status(503).json({
      success: false,
      error: {
        code: "STORAGE_NOT_CONFIGURED",
        message: "File storage is not configured on the server."
      }
    });
  }

  const attachment = await prisma.attachment.findFirst({
    where: { id: req.params.id, userId: req.user!.id }
  });
  if (!attachment) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "File not found." }
    });
  }

  try {
    const url = await getObjectUrl(attachment.storageKey, {
      filename: attachment.name,
      mime: attachment.mime,
      download: req.query.download === "1" || req.query.download === "true"
    });
    return res.json({
      success: true,
      data: {
        url,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size
      }
    });
  } catch (err) {
    logger.error({ err, attachmentId: attachment.id }, "Signed URL generation failed");
    return res.status(502).json({
      success: false,
      error: { code: "STORAGE_ERROR", message: "Could not create a download link." }
    });
  }
});

export default router;
