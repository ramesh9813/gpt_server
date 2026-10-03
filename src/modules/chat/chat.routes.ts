import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { resolveModelForRole, isImageOnlyModel, isVideoOnlyModel } from "../../lib/openrouter";
import { resolveEffectiveSystemPrompt, wantsArtifact } from "./artifact";
import { mergePromptLists, mutedIdsFromRow, promptsFromRow } from "../../lib/tuning";
import { logger } from "../../lib/logger";
import {
  getStoredFiles,
  getStoredImages,
  redactForLog,
  resolveUserPromptForTurn,
  sendImageReply,
  sendMcqReply,
  sendSimpleTextFinish,
  sendVideoReply,
  streamOpenRouterCompletion,
  streamSchema,
  wantsImageGeneration,
  wantsMcq,
  wantsVideo,
  type OpenRouterMessage,
} from "./chat.service";
import { buildHistoryMessages, fetchHistoryRows, resolveHistoryBudget } from "./history";
import { parseByokHeadersAsync } from "../../lib/providers";
import { streamByokCompletion } from "./byok";
import directRoutes from "./direct.routes";

const router = Router();

router.post("/stream", requireAuth, validateBody(streamSchema), async (req, res) => {
  const {
    conversationId,
    userMessage,
    existingUserMessageId,
    images,
    files,
    model,
    systemPrompt,
    research,
    artifact,
    webSearch,
    think,
    compactHistory,
    promptOnly,
  }: {
    conversationId: string;
    userMessage?: string;
    existingUserMessageId?: string;
    images?: string[];
    files?: Array<{ name: string; mime: string; size: number; content: string }>;
    model?: string;
    systemPrompt?: string;
    research?: boolean;
    artifact?: boolean;
    webSearch?: boolean;
    think?: boolean;
    compactHistory?: boolean;
    promptOnly?: boolean;
  } = req.body;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: req.user!.id, deletedAt: null },
  });
  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Conversation not found" },
    });
  }

  // Folder-level custom prompt (inherited by every chat inside the folder):
  // kicked off early so it resolves in parallel with the turn setup below.
  const folderTuningPromise = (conversation as { folderId?: string | null }).folderId
    ? prisma.folder.findFirst({
        where: {
          id: (conversation as { folderId?: string | null }).folderId as string,
          userId: req.user!.id,
        },
        select: { customPrompt: true, customPromptEnabled: true, customPrompts: true },
      })
    : Promise.resolve(null);

  // BYOK (bring-your-own-key): x-byok-* headers mean this chat turn runs on the
  // user's own provider key (stored only in their browser) instead of the
  // server-configured OpenRouter key. Absent headers = unchanged OpenRouter path.
  const byok = await parseByokHeadersAsync(req as any);
  if (byok && "error" in byok) {
    return res.status(400).json({
      success: false,
      error: { code: "BYOK_INVALID", message: byok.error },
    });
  }

  // Built-in (server-key) models are reserved for owner/admin. General users
  // chat by bringing their own provider key (Account → Settings → AI provider).
  if (!byok && req.user!.role !== "owner" && req.user!.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: {
        code: "BYOK_REQUIRED",
        message:
          "Built-in models are available on owner/admin accounts. Add your own API key in Account → Settings → AI provider to chat as much as you want with any provider.",
      },
    });
  }

  let selectedModel: string;
  if (byok) {
    selectedModel = `${byok.provider.id}:${byok.model}`;
  } else {
    const resolvedModel = await resolveModelForRole(req.user!.role, model);
    if (!resolvedModel.ok) {
      return res.status(resolvedModel.status).json({
        success: false,
        error: { code: resolvedModel.code, message: resolvedModel.message },
      });
    }
    selectedModel = resolvedModel.model;
  }

  // History budget for this turn: tight for low-tier providers, emergency
  // clamp when the client auto-trims near the limit. Applies to every model
  // (BYOK + built-in share the builders below).
  const historyBudget = resolveHistoryBudget(
    byok?.provider.id,
    compactHistory === true
  );

  let userMsgContent = userMessage || "";
  let userImages: string[] = Array.isArray(images) ? images : [];
  let userFiles: Array<{ name: string; mime: string; size: number; content: string }> = Array.isArray(files) ? files : [];
  // Real user-row id for this turn (retry path) or created below (fresh
  // path) — forwarded so failure events can name both rows for the
  // browser-direct fallback.
  let streamUserMessageId: string | undefined = existingUserMessageId;
  if (existingUserMessageId) {
    let existingMessage = await prisma.message.findFirst({
      where: { id: existingUserMessageId, conversationId, role: "USER" },
    });
    if (!existingMessage) {
      // Stale-id tolerance: retries/regenerations name the preceding user row
      // from client-local state, which can be outdated after a failed turn +
      // refetch. Fall back to the latest USER message in this conversation
      // instead of 404ing ("Message not found") the retry.
      existingMessage = await prisma.message.findFirst({
        where: { conversationId, role: "USER" },
        orderBy: { createdAt: "desc" },
      });
    }
    if (!existingMessage) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Message not found" },
      });
    }
    streamUserMessageId = existingMessage.id;
    userMsgContent = existingMessage.content;
    // Retry path: re-hydrate images/files from DB so client doesn't resend payloads.
    userImages = getStoredImages(existingMessage);
    userFiles = getStoredFiles(existingMessage);
  } else if (userMessage || userImages.length > 0 || userFiles.length > 0) {
    const prompt = resolveUserPromptForTurn(userMessage, userFiles);
    const filesMeta = userFiles.length > 0
      ? userFiles.map((f) => ({ name: f.name, mime: f.mime, size: f.size }))
      : undefined;
    const createdUserMsg = await prisma.message.create({
      data: {
        conversationId,
        role: "USER",
        content: prompt,
        images: userImages.length > 0 ? userImages : undefined,
        // Persist only file metas on the row content (full text already expanded
        // into prompt). Keep lightweight; client already rendered the strip.
        ...(filesMeta ? { files: filesMeta as any } : {}),
        status: "COMPLETE",
      } as any,
    });
    streamUserMessageId = createdUserMsg.id;
    // Drive all intent/history off the expanded prompt so files are visible.
    userMsgContent = prompt;
  }

  // Non-critical: derive title in background so it never delays TTFB.
  const trimmedTitle = userMsgContent.trim().replace(/\s+/g, " ");
  if (conversation.title === "New chat" && trimmedTitle.length > 0) {
    const derivedTitle = trimmedTitle.length > 60 ? `${trimmedTitle.slice(0, 57)}...` : trimmedTitle;
    prisma.conversation.update({ where: { id: conversationId }, data: { title: derivedTitle } }).catch(() => {});
  }

  // Parallelize the three blocking fetches before streaming — history + assistant
  // row + brand prompt — so every provider (OpenRouter, CleanAPIs, all BYOK)
  // pays the single slowest query, not the sum. Critical for fast TTFB.
  // History is fetched light (no historic image blobs — see fetchHistoryRows)
  // so long image chats don't stall the first token on multi-MB reads.
  const isArtifactTurn =
    artifact === true || wantsArtifact(userMsgContent);
  // Retry turns reuse the assistant row following the retried user message
  // (reset to a fresh STREAMING shell) instead of minting a second bubble:
  // regenerate then shows ONLY the new answer, never previous + new.
  // Fresh turns (or retries with no following row) create as before.
  const prepareAssistantRow = async () => {
    if (streamUserMessageId) {
      const userRow = await prisma.message.findFirst({
        where: { id: streamUserMessageId, conversationId },
      });
      if (userRow) {
        const following = await prisma.message.findFirst({
          where: {
            conversationId,
            role: "ASSISTANT",
            createdAt: { gt: userRow.createdAt },
          },
          orderBy: { createdAt: "asc" },
        });
        if (following) {
          return prisma.message.update({
            where: { id: following.id },
            data: {
              content: "",
              reasoning: null,
              status: "STREAMING",
              error: null,
              model: selectedModel,
              images: [],
              videos: [],
              quiz: null,
              sources: [],
              usedSearch: false,
              followups: [],
              promptTokens: null,
              completionTokens: null,
              tokenCount: null,
              durationMs: null,
            },
          });
        }
      }
    }
    return prisma.message.create({ data: { conversationId, role: "ASSISTANT", content: "", status: "STREAMING" } });
  };
  const [history, assistantMsg, effectiveSystemPrompt] = await Promise.all([
    fetchHistoryRows(conversationId, { includeUserMessageId: streamUserMessageId }),
    prepareAssistantRow(),
    resolveEffectiveSystemPrompt(req.user!.id, { userMsgContent, artifact, systemPrompt }),
  ]);
  // Per-chat tuning: merged as a guarded system block after the base prompt.
  // Folder prompts first (minus this chat's mutes), then the chat's own list.
  const folderRow = await folderTuningPromise;
  const mergedSystemPrompt = mergePromptLists(
    effectiveSystemPrompt,
    promptsFromRow(folderRow),
    promptsFromRow(conversation),
    mutedIdsFromRow(conversation)
  );

  // Prompt-only mode: drop past history — the turn is just this input plus
  // the custom prompt (system). The current user row is always kept so the
  // model still sees what was asked.
  const scopedHistory =
    promptOnly === true && streamUserMessageId
      ? history.filter(
          (r) => String((r as { id?: unknown })?.id ?? "") === streamUserMessageId
        )
      : history;

  // BYOK turn: plain-text chat streamed from the user's own provider key.
  // Image/video turns stay on built-in models (owner/admin only); general-key
  // users get a plain-text hint instead. Nothing below changes when BYOK
  // headers are absent.
  if (byok) {
    const isGeneralUser = req.user!.role === "user";
    if (isGeneralUser && (wantsVideo(userMsgContent) || isVideoOnlyModel(selectedModel))) {
      return sendSimpleTextFinish(req, res, {
        assistantMessageId: assistantMsg.id,
        conversationId,
        selectedModel,
        text: "Video generation is available on owner/admin accounts only. Add an admin role or keep chatting with your own provider key.",
      });
    }
    if (isGeneralUser && (wantsImageGeneration(userMsgContent) || isImageOnlyModel(selectedModel))) {
      return sendSimpleTextFinish(req, res, {
        assistantMessageId: assistantMsg.id,
        conversationId,
        selectedModel,
        text: "Image generation is available on owner/admin accounts only. You can still chat with your own provider key.",
      });
    }
    // MCQ quiz turns work on BYOK providers too (same prompt + parsing applied
    // to the user's own model instead of the server default).
    if (wantsMcq(userMsgContent)) {
      const topic = userMsgContent.replace(/^\s*mcq\b/i, "").trim();
      if (!topic) {
        return sendSimpleTextFinish(req, res, {
          assistantMessageId: assistantMsg.id,
          conversationId,
          selectedModel,
          text: "Tell me a topic for the quiz — e.g. `mcq solar system`.",
        });
      }
      const rawAsked = (conversation as unknown as { quizAsked?: unknown }).quizAsked;
      const askedBank: string[] = Array.isArray(rawAsked)
        ? rawAsked.filter((v): v is string => typeof v === "string")
        : [];
      let quizCount = 0;
      try {
        quizCount = await (prisma.message as any).count({
          where: { conversationId, NOT: { quiz: null } },
        });
      } catch {
        quizCount = 0;
      }
      const round = (typeof quizCount === "number" ? quizCount : 0) + 1;
      return sendMcqReply(req, res, {
        assistantMessageId: assistantMsg.id,
        conversationId,
        topic,
        selectedModel,
        askedBank,
        round,
        byok,
      });
    }
    const { messages, stats } = buildHistoryMessages(scopedHistory, {
      systemPrompt: mergedSystemPrompt,
      existingUserMessageId: streamUserMessageId,
      charBudget: historyBudget,
    });
    logger.info(
      { provider: byok.provider.name, model: byok.model, messages: redactForLog(messages as OpenRouterMessage[]), stats, think: think === true },
      "Sending BYOK messages"
    );
    return streamByokCompletion(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      messages: messages as OpenRouterMessage[],
      byok,
      userMessageId: streamUserMessageId,
      think: think === true,
      artifact: isArtifactTurn,
      webSearch: webSearch === true,
    });
  }

  // MCQ quiz turn: `mcq <topic>` generates 10 MCQs as a quiz event (no stream).
  // Must run BEFORE the image branch so `mcq ...` never triggers image intent.
  // Applies to fresh turns AND edit/regenerate retries so an edited mcq prompt
  // stays a quiz instead of degrading to plain chat text.
  if (wantsMcq(userMsgContent)) {
    const topic = userMsgContent.replace(/^\s*mcq\b/i, "").trim();
    if (!topic) {
      return sendSimpleTextFinish(req, res, {
        assistantMessageId: assistantMsg.id,
        conversationId,
        selectedModel,
        text: "Tell me a topic for the quiz — e.g. `mcq solar system`.",
      });
    }
    const rawAsked = (conversation as unknown as { quizAsked?: unknown }).quizAsked;
    const askedBank: string[] = Array.isArray(rawAsked)
      ? rawAsked.filter((v): v is string => typeof v === "string")
      : [];
    let quizCount = 0;
    try {
      quizCount = await (prisma.message as any).count({
        where: { conversationId, NOT: { quiz: null } },
      });
    } catch {
      quizCount = 0;
    }
    const round = (typeof quizCount === "number" ? quizCount : 0) + 1;
    return sendMcqReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      topic,
      selectedModel,
      askedBank,
      round,
    });
  }

  // Video-generation turn: capability-checked, saved with videos.
  // Must run BEFORE the image branch so `generate video ...` never triggers image intent.
  // Applies to retries too so an edited video prompt stays a video turn.
  if (wantsVideo(userMsgContent) || isVideoOnlyModel(selectedModel)) {
    return sendVideoReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      prompt: userMsgContent,
      selectedModel,
      history,
    } as any);
  }

  // Image-generation turn: capability-checked, saved with images.
  // Applies to retries too so an edited image prompt stays an image turn.
  if (wantsImageGeneration(userMsgContent) || isImageOnlyModel(selectedModel)) {
    return sendImageReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      prompt: userMsgContent,
      selectedModel,
      history,
      images: userImages,
    } as any);
  }

  // Artifact turns continue the NORMAL streaming path below — no special
  // events, no new SSE type.

  // Token-budgeted history (payload only — DB untouched). Rebuilt from DB every
  // turn so memory survives model switches; retry slices to the resolved user
  // row (streamUserMessageId), which is the fallback id when the client id was stale.
  const { messages, stats } = buildHistoryMessages(scopedHistory, {
    systemPrompt: mergedSystemPrompt,
    existingUserMessageId: streamUserMessageId,
    charBudget: historyBudget,
  });
  logger.info(
    { messages: redactForLog(messages as OpenRouterMessage[]), stats },
    "Sending messages to OpenRouter"
  );

  return streamOpenRouterCompletion(req, res, {
    assistantMessageId: assistantMsg.id,
    conversationId,
    messages: messages as OpenRouterMessage[],
    selectedModel,
    research: research === true,
    artifact: isArtifactTurn,
    webSearch: webSearch === true,
    think: think === true,
    // Connector tools (Canva): resolved best-effort inside the streamer.
    // Disconnected users get [] and byte-identical behavior to before.
    canvaUserId: req.user!.id,
  });
});

// Browser-direct fallback routes (/direct-prepare, /direct-finish): nested
// here so they share the /api/chat mount (and its rate limit) without
// touching app.ts.
router.use(directRoutes);

export default router;
