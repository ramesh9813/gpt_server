import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { parseByokHeadersAsync } from "../../lib/providers";
import { resolveEffectiveSystemPrompt } from "./artifact";
import { mergeSystemPrompt } from "../../lib/tuning";
import { buildHistoryMessages } from "./history";
import { wantsMcq } from "./mcq";
import { wantsImageGeneration, wantsVideo } from "./intents";
import type { OpenRouterMessage } from "./chat.service";

const router = Router();

const prepareSchema = z.object({
  conversationId: z.string(),
  assistantMessageId: z.string(),
  existingUserMessageId: z.string(),
  artifact: z.boolean().optional(),
});

// POST /api/chat/direct-prepare — browser-direct fallback for firewalled
// relays. When the provider's firewall blocks the SERVER (Cloudflare check),
// the browser can usually still reach it (open CORS) with the user's own key
// from Settings. This re-derives the exact provider payload for a failed
// BYOK text turn and resets its assistant row; the browser streams the turn
// itself, then POSTs /direct-finish. The key is never needed here — only row
// ownership is verified, and nothing provider-secret is returned (the
// messages are the user's own thread, already readable via /messages).
router.post(
  "/direct-prepare",
  requireAuth,
  validateBody(prepareSchema),
  async (req, res) => {
    const {
      conversationId,
      assistantMessageId,
      existingUserMessageId,
      artifact,
    } = req.body as z.infer<typeof prepareSchema>;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId: req.user!.id, deletedAt: null },
    });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" },
      });
    }

    // Folder-level custom prompt, resolved in parallel with the lookups below.
    const folderTuningPromise = (conversation as { folderId?: string | null }).folderId
      ? prisma.folder.findFirst({
          where: {
            id: (conversation as { folderId?: string | null }).folderId as string,
            userId: req.user!.id,
          },
          select: { customPrompt: true, customPromptEnabled: true },
        })
      : Promise.resolve(null);

    const assistantMsg = await prisma.message.findFirst({
      where: { id: assistantMessageId, conversationId, role: "ASSISTANT" },
    });
    if (!assistantMsg) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Assistant message not found" },
      });
    }

    let userMsg = await prisma.message.findFirst({
      where: { id: existingUserMessageId, conversationId, role: "USER" },
    });
    if (!userMsg) {
      // Same stale-id tolerance as POST /api/chat/stream: fall back to the
      // latest USER message so the browser-direct retry survives a refetch.
      userMsg = await prisma.message.findFirst({
        where: { conversationId, role: "USER" },
        orderBy: { createdAt: "desc" },
      });
    }
    if (!userMsg) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Message not found" },
      });
    }
    const effectiveUserMessageId = userMsg.id;

    const byok = await parseByokHeadersAsync(req as any);
    if (byok && "error" in byok) {
      return res.status(400).json({
        success: false,
        error: { code: "BYOK_INVALID", message: byok.error },
      });
    }
    if (!byok) {
      // Mirrors /stream: direct mode exists only to route around a blocked
      // relay, which needs the user's own provider key.
      if (req.user!.role !== "owner" && req.user!.role !== "admin") {
        return res.status(403).json({
          success: false,
          error: {
            code: "BYOK_REQUIRED",
            message:
              "Built-in models are available on owner/admin accounts. Add your own API key in Account → Settings → AI provider to chat as much as you want with any provider.",
          },
        });
      }
      return res.status(400).json({
        success: false,
        error: {
          code: "DIRECT_UNSUPPORTED",
          message: "Browser-direct streaming needs your own provider key.",
        },
      });
    }
    // Only the OpenAI-shaped path is reproducible in the browser; Gemini /
    // Anthropic wire formats differ.
    if (byok.provider.kind !== "openai") {
      return res.status(400).json({
        success: false,
        error: {
          code: "DIRECT_UNSUPPORTED",
          message: `Browser-direct streaming is not supported for ${byok.provider.name} yet.`,
        },
      });
    }
    // Quiz and media turns run server-driven flows the browser path can't
    // reproduce — plain-text turns only.
    if (
      wantsMcq(userMsg.content) ||
      wantsImageGeneration(userMsg.content) ||
      wantsVideo(userMsg.content)
    ) {
      return res.status(400).json({
        success: false,
        error: {
          code: "DIRECT_UNSUPPORTED",
          message: "Quiz and media turns can't run browser-direct.",
        },
      });
    }

    const effectiveSystemPrompt = await resolveEffectiveSystemPrompt(
      req.user!.id,
      { userMsgContent: userMsg.content, artifact }
    );
    const tuningPrompt = (conversation as unknown as { customPrompt?: string | null }).customPrompt ?? null;
    const tuningEnabled = (conversation as unknown as { customPromptEnabled?: boolean }).customPromptEnabled ?? true;
    const folderRow = await folderTuningPromise;
    const withFolderPrompt = mergeSystemPrompt(
      effectiveSystemPrompt,
      folderRow?.customPrompt ?? null,
      folderRow?.customPromptEnabled ?? true
    );
    const mergedSystemPrompt = mergeSystemPrompt(withFolderPrompt, tuningPrompt, tuningEnabled);
    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
    const { messages } = buildHistoryMessages(history, {
      systemPrompt: mergedSystemPrompt,
      existingUserMessageId: effectiveUserMessageId,
    });

    await prisma.message.update({
      where: { id: assistantMsg.id },
      data: { content: "", reasoning: null, status: "STREAMING", error: null },
    });

    return res.json({
      success: true,
      data: {
        assistantMessageId: assistantMsg.id,
        conversationId,
        messages: messages as OpenRouterMessage[],
        model: byok.model,
        provider: byok.provider.id,
        // Public endpoint root (docs-listed, not secret) so the browser can
        // stream the turn itself with the user's own key.
        baseUrl: byok.provider.baseUrl,
      },
    });
  }
);

const finishSchema = z.object({
  conversationId: z.string(),
  assistantMessageId: z.string(),
  content: z.string().max(200000),
  reasoning: z.string().max(100000).optional(),
  model: z.string().max(200).optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  tokenCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().max(2000).optional(),
});

// POST /api/chat/direct-finish — persist a browser-direct turn (or its
// failure) onto the prepared assistant row. Ownership-checked; content is
// size-capped. Never touches provider keys.
router.post(
  "/direct-finish",
  requireAuth,
  validateBody(finishSchema),
  async (req, res) => {
    const {
      conversationId,
      assistantMessageId,
      content,
      reasoning,
      model,
      promptTokens,
      completionTokens,
      tokenCount,
      durationMs,
      error,
    } = req.body as z.infer<typeof finishSchema>;

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId: req.user!.id, deletedAt: null },
    });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" },
      });
    }

    const assistantMsg = await prisma.message.findFirst({
      where: { id: assistantMessageId, conversationId, role: "ASSISTANT" },
    });
    if (!assistantMsg) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Assistant message not found" },
      });
    }

    if (error) {
      await prisma.message.update({
        where: { id: assistantMsg.id },
        data: {
          content: content || "",
          status: "ERROR",
          error,
          ...(model ? { model } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      });
    } else {
      await prisma.message.update({
        where: { id: assistantMsg.id },
        data: {
          content,
          ...(reasoning ? { reasoning } : {}),
          status: "COMPLETE",
          ...(model ? { model } : {}),
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
          ...(tokenCount !== undefined ? { tokenCount } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      });
    }
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return res.json({
      success: true,
      data: { messageId: assistantMsg.id },
    });
  }
);

export default router;
