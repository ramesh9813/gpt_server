import { prisma } from "../../lib/prisma";
import { isImageOnlyModel, isVideoOnlyModel, resolveModelForRole } from "../../lib/openrouter";
import { resolveEffectiveSystemPrompt, wantsArtifact } from "./artifact";
import { mergePromptLists, mutedIdsFromRow, promptsFromRow } from "../../lib/tuning";
import { logger } from "../../lib/logger";
import { getStoredFiles, getStoredImages, redactForLog, resolveUserPromptForTurn, type OpenRouterMessage } from "./chatMappers";
import { buildHistoryMessages, fetchHistoryRows } from "./history";
import { parseByokHeadersAsync } from "../../lib/providers";
import { streamByokCompletion } from "./byok";
import { sendImageReply, sendVideoReply } from "./mediaReply";
import { sendMcqReply, wantsMcq } from "./mcq";
import { wantsImageGeneration, wantsVideo } from "./intents";
import { sendSimpleTextFinish, streamOpenRouterCompletion } from "./chat.service";
import type { Request, Response } from "express";

export const handleStream = async (req: Request, res: Response) => {
  const { conversationId, userMessage, existingUserMessageId, images, files, model, systemPrompt, research, artifact, webSearch, think } = req.body as any;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: (req as any).user!.id, deletedAt: null } });
  if (!conversation) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });

  // Folder-level custom prompt (WIP mirror of deployed fix): kicked off early.
  const folderTuningPromise = (conversation as { folderId?: string | null }).folderId
    ? prisma.folder.findFirst({
        where: {
          id: (conversation as { folderId?: string | null }).folderId as string,
          userId: (req as any).user!.id,
        },
        select: { customPrompt: true, customPromptEnabled: true, customPrompts: true },
      })
    : Promise.resolve(null);

  const byok = await parseByokHeadersAsync(req as any);
  if (byok && "error" in byok) return res.status(400).json({ success: false, error: { code: "BYOK_INVALID", message: byok.error } });
  if (!byok && (req as any).user!.role !== "owner" && (req as any).user!.role !== "admin") {
    return res.status(403).json({ success: false, error: { code: "BYOK_REQUIRED", message: "Built-in models are available on owner/admin accounts. Add your own API key in Account → Settings → AI provider to chat as much as you want with any provider." } });
  }

  let selectedModel: string;
  if (byok) selectedModel = `${byok.provider.id}:${byok.model}`;
  else {
    const r = await resolveModelForRole((req as any).user!.role, model);
    if (!r.ok) return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } });
    selectedModel = r.model;
  }

  let userMsgContent = userMessage || "";
  let userImages: string[] = Array.isArray(images) ? images : [];
  let userFiles: Array<{ name: string; mime: string; size: number; content: string }> = Array.isArray(files) ? files : [];
  let streamUserMessageId: string | undefined = existingUserMessageId;

  if (existingUserMessageId) {
    let existingMessage = await prisma.message.findFirst({ where: { id: existingUserMessageId, conversationId, role: "USER" } });
    if (!existingMessage) {
      // Stale-id tolerance (kept in sync with deployed fix be402eb):
      // retries name the preceding user row from client-local state, which
      // can be outdated after a failed turn + refetch. Fall back to the
      // latest USER message instead of 404ing the retry.
      existingMessage = await prisma.message.findFirst({ where: { conversationId, role: "USER" }, orderBy: { createdAt: "desc" } });
    }
    if (!existingMessage) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Message not found" } });
    streamUserMessageId = existingMessage.id;
    userMsgContent = existingMessage.content;
    userImages = getStoredImages(existingMessage);
    userFiles = getStoredFiles(existingMessage);
  } else if (userMessage || userImages.length > 0 || userFiles.length > 0) {
    const prompt = resolveUserPromptForTurn(userMessage, userFiles);
    const filesMeta = userFiles.length > 0 ? userFiles.map((f) => ({ name: f.name, mime: f.mime, size: f.size })) : undefined;
    const created = await prisma.message.create({
      data: { conversationId, role: "USER", content: prompt, images: userImages.length > 0 ? userImages : undefined, ...(filesMeta ? { files: filesMeta as any } : {}), status: "COMPLETE" } as any,
    });
    streamUserMessageId = created.id;
    userMsgContent = prompt;
  }

  const trimmedTitle = userMsgContent.trim().replace(/\s+/g, " ");
  if ((conversation as any).title === "New chat" && trimmedTitle.length > 0) {
    const derived = trimmedTitle.length > 60 ? `${trimmedTitle.slice(0, 57)}...` : trimmedTitle;
    prisma.conversation.update({ where: { id: conversationId }, data: { title: derived } }).catch(() => {});
  }

  const isArtifactTurn = artifact === true || wantsArtifact(userMsgContent);
  const [history, assistantMsg, effectiveSystemPrompt] = await Promise.all([
    fetchHistoryRows(conversationId, { includeUserMessageId: streamUserMessageId }),
    prisma.message.create({ data: { conversationId, role: "ASSISTANT", content: "", status: "STREAMING" } }),
    resolveEffectiveSystemPrompt((req as any).user!.id, { userMsgContent, artifact, systemPrompt }),
  ]);
  const folderRow = await folderTuningPromise;
  // Todo-list tuning: folder prompts first (minus this chat's mutes), then
  // the chat's own prompts. Legacy single-prompt rows read as one item.
  const mergedSystemPrompt = mergePromptLists(
    effectiveSystemPrompt,
    promptsFromRow(folderRow),
    promptsFromRow(conversation),
    mutedIdsFromRow(conversation)
  );

  const wantsMcqFor = (content: string) => wantsMcq(content);
  const handleMcq = async (topicRaw: string, byokArg?: any) => {
    const topic = topicRaw.replace(/^\s*mcq\b/i, "").trim();
    if (!topic) return sendSimpleTextFinish(req, res, { assistantMessageId: assistantMsg.id, conversationId, selectedModel, text: "Tell me a topic for the quiz — e.g. `mcq solar system`." });
    const rawAsked = (conversation as unknown as { quizAsked?: unknown }).quizAsked;
    const askedBank: string[] = Array.isArray(rawAsked) ? rawAsked.filter((v): v is string => typeof v === "string") : [];
    let quizCount = 0;
    try { quizCount = await (prisma.message as any).count({ where: { conversationId, NOT: { quiz: null } } }); } catch { quizCount = 0; }
    const round = (typeof quizCount === "number" ? quizCount : 0) + 1;
    return sendMcqReply(req, res, { assistantMessageId: assistantMsg.id, conversationId, topic, selectedModel, askedBank, round, ...(byokArg ? { byok: byokArg } : {}) });
  };

  if (byok) {
    const isGeneralUser = (req as any).user!.role === "user";
    if (isGeneralUser && (wantsVideo(userMsgContent) || isVideoOnlyModel(selectedModel))) {
      return sendSimpleTextFinish(req, res, { assistantMessageId: assistantMsg.id, conversationId, selectedModel, text: "Video generation is available on owner/admin accounts only. Add an admin role or keep chatting with your own provider key." });
    }
    if (isGeneralUser && (wantsImageGeneration(userMsgContent) || isImageOnlyModel(selectedModel))) {
      return sendSimpleTextFinish(req, res, { assistantMessageId: assistantMsg.id, conversationId, selectedModel, text: "Image generation is available on owner/admin accounts only. You can still chat with your own provider key." });
    }
    if (wantsMcqFor(userMsgContent)) return handleMcq(userMsgContent, byok);
    const { messages, stats } = buildHistoryMessages(history, { systemPrompt: mergedSystemPrompt, existingUserMessageId: streamUserMessageId });
    logger.info({ provider: byok.provider.name, model: byok.model, messages: redactForLog(messages as OpenRouterMessage[]), stats, think: think === true }, "Sending BYOK messages");
    return streamByokCompletion(req, res, { assistantMessageId: assistantMsg.id, conversationId, messages: messages as OpenRouterMessage[], byok, userMessageId: streamUserMessageId, think: think === true, artifact: isArtifactTurn, webSearch: webSearch === true });
  }

  if (wantsMcqFor(userMsgContent)) return handleMcq(userMsgContent);
  if (wantsVideo(userMsgContent) || isVideoOnlyModel(selectedModel)) return sendVideoReply(req, res, { assistantMessageId: assistantMsg.id, conversationId, prompt: userMsgContent, selectedModel, history } as any);
  if (wantsImageGeneration(userMsgContent) || isImageOnlyModel(selectedModel)) return sendImageReply(req, res, { assistantMessageId: assistantMsg.id, conversationId, prompt: userMsgContent, selectedModel, history, images: userImages } as any);

  const { messages, stats } = buildHistoryMessages(history, { systemPrompt: mergedSystemPrompt, existingUserMessageId: streamUserMessageId });
  logger.info({ messages: redactForLog(messages as OpenRouterMessage[]), stats }, "Sending messages to OpenRouter");
  return streamOpenRouterCompletion(req, res, { assistantMessageId: assistantMsg.id, conversationId, messages: messages as OpenRouterMessage[], selectedModel, research: research === true, artifact: isArtifactTurn, webSearch: webSearch === true, think: think === true, canvaUserId: (req as any).user!.id });
};
