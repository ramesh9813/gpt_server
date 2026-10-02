import { z } from "zod";
import { imageDataUrlSchema, MAX_IMAGES } from "../../lib/imageValidation";
import { fileAttachmentsSchema } from "../../lib/fileAttachments";

export const streamSchema = z
  .object({
    conversationId: z.string().min(1),
    userMessage: z.string().min(1).max(8000).optional(),
    existingUserMessageId: z.string().min(1).optional(),
    images: z.array(imageDataUrlSchema).max(MAX_IMAGES).optional(),
    files: fileAttachmentsSchema,
    model: z.string().min(1).max(200).optional(),
    systemPrompt: z.string().max(8000).optional(),
    research: z.boolean().optional(),
    artifact: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    think: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.userMessage ||
      data.existingUserMessageId ||
      (data.images && data.images.length > 0) ||
      (Array.isArray((data as any).files) && (data as any).files.length > 0),
    { message: "userMessage or existingUserMessageId or images or files is required" }
  )
  .refine((data) => !(data.userMessage && data.existingUserMessageId), {
    message: "Provide either userMessage or existingUserMessageId",
  });

export type StreamRequestBody = z.infer<typeof streamSchema>;
