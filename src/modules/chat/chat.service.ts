import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { generateFollowups, isFollowupsEnabled } from "./followups";
import {
  getAvailableTools,
  getWebSearchToolDef,
  executeToolCallsParallel,
  MAX_PARALLEL_TOOL_CALLS,
  type LlmToolDef,
} from "../llm/toolBridge";
import { imageDataUrlSchema, MAX_IMAGES } from "../../lib/imageValidation";
import { fileAttachmentsSchema } from "../../lib/fileAttachments";
import { combineFilesIntoPrompt } from "../../lib/fileAttachments";
import { TOKEN } from "../../lib/constants";
import { buildSearchContextBlock, enrichWithImages, ensureSingleSourcesSection, hasAttachedDocument, performWebSearchWithProvider, stageLineForSource, wantsWebSearch, wantsSearchImages, type WebResult } from "../../lib/websearch";
import { openRouterAgentLlm, runDeepResearch } from "./deepResearch";
import { APP_ROUTING_SYSTEM, artifactFenceOf, executeAppTool, getAppToolDefs, isAppToolName, mcqQuizPayload, type AppToolUi } from "./appTools";
import { isTokenLimitRejection } from "./byokRequest";
import { extractPageUrls, fetchLinkedPages, pageHost } from "../../lib/pageContent";
import { extractYouTubeVideoId, fetchVideoTranscriptFor, transcriptUnavailableNote, wantsTranscript } from "../../lib/youtubeTranscript";
import { SEARCH_DEPTH_DEFAULT, researchSearchDepth, resolveSearchDepth, resolveSearchProvider, searchProviderLabel } from "../../lib/searchSettings";

export const streamSchema = z
  .object({
    conversationId: z.string().min(1),
    userMessage: z.string().min(1).optional(),
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
  .refine((data) => data.userMessage || data.existingUserMessageId || (data.images && data.images.length > 0) || (Array.isArray((data as any).files) && (data as any).files.length > 0), {
    message: "userMessage or existingUserMessageId or images or files is required",
  })
  .refine((data) => !(data.userMessage && data.existingUserMessageId), {
    message: "Provide either userMessage or existingUserMessageId",
  });

export type StreamRequestBody = z.infer<typeof streamSchema>;

export type OpenRouterTextPart = { type: "text"; text: string };
export type OpenRouterImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenRouterAudioPart = { type: "input_audio"; input_audio: { data: string; format: string } };
export type OpenRouterContent = string | Array<OpenRouterTextPart | OpenRouterImagePart | OpenRouterAudioPart>;
export type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: OpenRouterContent };

export const mapRole = (role: string): OpenRouterMessage["role"] => {
  if (role === "SYSTEM") return "system";
  if (role === "ASSISTANT") return "assistant";
  return "user";
};

export const buildUserContent = (text: string, images?: string[]): OpenRouterContent => {
  if (!images || images.length === 0) return text;
  const safeText = text && text.trim().length > 0 ? text : "Describe the attached image(s) in detail.";
  return [{ type: "text", text: safeText }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))];
};

export const getStoredImages = (msg: unknown): string[] => {
  const raw = (msg as { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.startsWith("data:image/"));
};

export const getStoredFiles = (msg: unknown): Array<{ name: string; mime: string; size: number; content: string; dataUrl?: string; attachmentId?: string }> => {
  const raw = (msg as { files?: unknown }).files;
  if (!Array.isArray(raw)) return [];
  return (raw as any[]).filter(
    (v) => v && typeof v.name === "string" && typeof v.content === "string"
  ) as any;
};

export const resolveUserPromptForTurn = (
  userMessage: string | undefined,
  files: Array<{ name: string; mime: string; size: number; content: string; dataUrl?: string; attachmentId?: string }> | undefined
): string => {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return userMessage ?? "";
  return combineFilesIntoPrompt(userMessage ?? "", list as any);
};

// Avoid dumping multi-MB base64 into logs.
export const redactForLog = (messages: OpenRouterMessage[]) =>
  messages.map((m) => {
    if (typeof m.content === "string") return m;
    return {
      ...m,
      content: (m.content as Array<OpenRouterTextPart | OpenRouterImagePart | OpenRouterAudioPart>).map((p) =>
        p.type === "image_url"
          ? { type: p.type, image_url: { url: `[omitted dataURL length=${p.image_url.url.length}]` } }
          : p.type === "input_audio"
            ? { type: p.type, input_audio: { data: `[omitted audio length=${p.input_audio.data.length}]`, format: p.input_audio.format } }
            : p
      ),
    };
  });


// Deep Research: dedicated research models (e.g. perplexity/sonar-deep-research,
// openai/o3-deep-research) search and synthesize autonomously. This prompt asks
// for a thorough, sourced report; max_tokens is raised since reports are long.
export const RESEARCH_SYSTEM_PROMPT =
  "You are a deep research analyst. Investigate the user's topic thoroughly using every source available to you. " +
  "Produce a comprehensive, well-structured report with clear headings, key findings up front, detailed analysis, " +
  "citing the URLs you rely on inline. Do NOT write a Sources or References section — the app renders the source " +
  "list below the answer automatically. Be factual and note uncertainty where sources disagree.";

// Web search (OpenRouter server tool): the model searches live website
// content and cites sources with markdown links. Opt-in per turn via
// `webSearch`; website search ONLY — never a reasoning/research process.
// Skipped when deep-research mode is on (those models search autonomously
// and may reject extra tools).
export const WEB_SEARCH_SYSTEM_PROMPT =
  "You have live web search. Synthesize answers from search results and cite sources with markdown links.";

export const streamOpenRouterCompletion = async (
  req: Request,
  res: Response,
  opts: { assistantMessageId: string; conversationId: string; messages: OpenRouterMessage[]; selectedModel: string; research?: boolean; artifact?: boolean; webSearch?: boolean; think?: boolean; canvaUserId?: string }
) => {
  const { assistantMessageId, conversationId, messages, selectedModel, research, artifact, webSearch, think, canvaUserId } = opts;
  const startedAt = Date.now();
  // Reasoning stream: forwarded for deep-research turns, and for explicit
  // "Thinking" mode turns (Think chip in the composer). Plain/web-search turns
  // still get plain answers even if the model emits thinking tokens.
  const allowReasoning = research === true || think === true;
  if (!env.OPENROUTER_API_KEY) {
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: "OPENROUTER_API_KEY is not configured on the server." },
    });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "none",
      Pragma: "no-cache",
    });
    try {
      (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
    } catch {}
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ code: "CONFIG_ERROR", message: "OPENROUTER_API_KEY is not configured on the server. Please set it in your Render environment variables." })}\n\n`);
    return res.end();
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
    Pragma: "no-cache",
  });
  try {
    (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
  } catch {}
  try {
    (res.socket as unknown as { setNoDelay?: (v: boolean) => void })?.setNoDelay?.(true);
  } catch {}
  const sendEvent = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      (res as unknown as { flush?: () => void }).flush?.();
    } catch {}
  };
  const safeEnd = () => {
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  let assistantContent = "";
  let assistantReasoning = "";
  // Provider stop reason (finish_reason): "length" means the answer was cut
  // at the output ceiling — surfaced below, never a silent trim.
  let stopReason: string | null = null;
  let lastPersistedLength = 0;
  let lastPersistedAt = Date.now();
  // Web-search citations collected from the provider stream (url_citation
  // annotations), plus a user-facing notice when search couldn't run.
  const sourceMap = new Map<string, { title: string; url: string; image?: string }>();
  let searchNotice: string | null = null;
  const collectAnnotations = (chunk: any) => {
    const anns = chunk?.choices?.[0]?.delta?.annotations;
    if (!Array.isArray(anns)) return;
    for (const a of anns) {
      const c = a?.url_citation;
      if (c && typeof c.url === "string" && c.url) {
        sourceMap.set(c.url, {
          url: c.url,
          title: typeof c.title === "string" && c.title ? c.title : c.url,
        });
      }
    }
  };
  // Connector tools (Canva, OpenAI function-calling schema). Best-effort:
  // [] when disconnected/unconfigured, so the streaming path below is
  // untouched for everyone else. Skipped for deep-research turns (those
  // models search autonomously and may reject extra tools) — same
  // rationale as the web-search tool skip.
  // Lazy-loaded: resolved on first tool-choice turn only so TTFB is not
  // delayed for every provider (esp. CleanAPIs / BYOK).
  let canvaTools: LlmToolDef[] = [];
  let canvaToolsLoaded = false;
  const loadCanvaTools = async (): Promise<LlmToolDef[]> => {
    if (canvaToolsLoaded) return canvaTools;
    canvaToolsLoaded = true;
    if (!canvaUserId || research === true) return canvaTools;
    try {
      canvaTools = await getAvailableTools(canvaUserId);
    } catch {
      canvaTools = [];
    }
    return canvaTools;
  };
  type PendingToolCall = { id: string; name: string; arguments: string };
  // Use logger (with redaction) instead of console.log; never log raw images.
  const { logger: svcLogger } = await import("../../lib/logger");
  svcLogger.info({ messages: redactForLog(messages) }, "Sending messages to OpenRouter");

  // Universal search: server-side runs for EVERY model (no API
  // key, no provider-native tool needed). Toggle OR automatic on
  // search/news/recency intent. Results are injected into the
  // prompt AND pre-seeded into sourceMap so URLs land at the bottom even
  // when the model emits no url_citation annotations.
  let searchMessages = messages;
  // Resolved once per turn, reused by pre-turn injection, the native
  // web tool and the model-driven search tool — one dynamic depth for
  // every provider (built-in or added), never a hardcoded count.
  let searchDepth = SEARCH_DEPTH_DEFAULT;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const rawQuery =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? (lastUser.content as any[]).filter((p) => p?.type === "text").map((p) => p.text).join("\n")
        : "";
  // YouTube link + transcribe ask: fetch the captions and answer from the
  // exact spoken text. Then pasted page links, then web search (never on
  // research turns). Stage events narrate the wait above the typing dots.
  // Attached files (PDF/text/audio) are answered from the document itself:
  // never auto-run transcript / page-fetch / web search on the document's
  // own words. An explicit search toggle still applies.
  const hasDoc = hasAttachedDocument(rawQuery);
  // Follow-ups run PARALLEL to the answer: kicked off once ~300 chars have
  // streamed (opening paragraphs carry the gist), awaited at stream end. The
  // extra LLM round trip hides inside the remaining answer instead of
  // lagging after `done`. Never rejects (resolves [] on any failure).
  let followupsPromise: Promise<string[]> | null = null;
  const kickFollowups = (snapshot: string) => {
    if (followupsPromise) return;
    const uid = (req as any).user?.id;
    followupsPromise = (async (): Promise<string[]> => {
      try {
        if (!(await isFollowupsEnabled(uid))) return [];
        return await generateFollowups(selectedModel, snapshot);
      } catch {
        return [];
      }
    })();
  };
  const ytId = extractYouTubeVideoId(rawQuery);
  const ytWanted = ytId !== null && wantsTranscript(rawQuery) && !hasDoc;
  if (ytWanted) sendEvent("stage", { text: "Getting transcript…" });
  const yt = hasDoc ? null : await fetchVideoTranscriptFor(rawQuery).catch(() => null);
  if (yt && "block" in yt) {
    sendEvent("stage", { text: `Reading transcript (${yt.lines} lines)…` });
    for (const s of yt.sources) {
      if (!sourceMap.has(s.url)) sourceMap.set(s.url, { url: s.url, title: s.title });
    }
    searchMessages = [
      { role: "system", content: `${WEB_SEARCH_SYSTEM_PROMPT}\n\n${yt.block}` },
      ...messages,
    ];
  } else {
  const pageUrls = extractPageUrls(rawQuery);
  if (pageUrls.length > 0 && !hasDoc) sendEvent("stage", { text: `Opening ${pageHost(pageUrls[0])}…` });
  const linked = hasDoc ? null : await fetchLinkedPages(rawQuery).catch(() => null);
  if (linked) {
    linked.sources.forEach((s, i) =>
      sendEvent("stage", { text: stageLineForSource(i, linked.sources.length, s.title, s.url) })
    );
    for (const h of linked.sources) {
      if (!sourceMap.has(h.url)) sourceMap.set(h.url, { url: h.url, title: h.title });
    }
    searchMessages = [
      { role: "system", content: `${WEB_SEARCH_SYSTEM_PROMPT}\n\n${linked.block}` },
      ...messages,
    ];
  } else if (webSearch === true || wantsWebSearch(rawQuery) || (!hasDoc && research === true)) {
    const query = rawQuery.replace(/\[.*?\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    if (query) {
      try {
        const searchProvider = await resolveSearchProvider((req as any).user?.id);
        searchDepth = await resolveSearchDepth((req as any).user?.id);
        // Deep research fans out wide (20-60 sites from the user's own depth)
        // on the CURRENT model — no model suitability check, any model digs.
        if (research === true) searchDepth = researchSearchDepth(searchDepth);
        const short = query.length > 60 ? `${query.slice(0, 57)}…` : query;
        const pickLabel = searchProvider === "auto" ? "web" : searchProviderLabel(searchProvider);
        if (research !== true) sendEvent("stage", { text: `Searching ${pickLabel} for “${short}”…` });
        let rawHits: WebResult[];
        if (research === true) {
          // Agent pipeline: PLANNER splits the question, RESEARCHERS run in
          // parallel (web_search + fetch_page tools), an adversarial VERIFIER
          // turns gaps into targeted re-research. The streaming call below is
          // the WRITER — it writes the report from the verified-findings brief.
          const { brief, sources } = await runDeepResearch({
            question: query,
            provider: searchProvider,
            depth: searchDepth,
            llm: openRouterAgentLlm(selectedModel),
            onStage: (text) => sendEvent("stage", { text }),
            onSource: (s) => {
              if (!sourceMap.has(s.url)) sourceMap.set(s.url, { url: s.url, title: s.title });
            },
            isAborted: () => controller.signal.aborted,
          });
          if (sources.length > 0) {
            sendEvent("sources", { messageId: assistantMessageId, sources });
          }
          rawHits = [];
          if (brief) {
            searchMessages = [{ role: "system", content: brief }, ...messages];
          }
        } else {
          rawHits = (await performWebSearchWithProvider(query, searchDepth, searchProvider)).hits;
        }
        // Photos only on image-intent turns — every other search stays a fast,
        // imageless text path (no og:image fetches at all).
        const hits = wantsSearchImages(query) ? await enrichWithImages(rawHits) : rawHits;
        hits.forEach((h, i) =>
          sendEvent("stage", { text: stageLineForSource(i, hits.length, h.title, h.url, h.snippet) })
        );
        const photoCount = hits.filter((h) => h.image).length;
        if (photoCount > 0) sendEvent("stage", { text: `Adding ${photoCount} photo${photoCount === 1 ? "" : "s"}…` });
        for (const h of hits) {
          if (!sourceMap.has(h.url)) {
            sourceMap.set(h.url, { url: h.url, title: h.title, ...(h.image ? { image: h.image } : {}) });
          }
        }
        if (hits.length > 0) {
          const block = buildSearchContextBlock(query, hits);
          searchMessages = [
            { role: "system", content: `${WEB_SEARCH_SYSTEM_PROMPT}\n\n${block}` },
            ...messages,
          ];
        }
      } catch (err) {
        const { logger: svcLogger2 } = await import("../../lib/logger");
        svcLogger2.warn({ err }, "Universal web search failed, continuing without results");
      }
    }
  }
  }
  // Transcribe was asked but the captions were not retrievable: name the
  // exact cause (no captions vs unreachable vs unplayable) instead of
  // letting the model fall back to a generic "I can't browse" refusal.
  if (yt && "unavailable" in yt && searchMessages === messages) {
    const stageText =
      yt.unavailable === "unreachable"
        ? "YouTube unreachable…"
        : yt.unavailable === "unplayable"
          ? "Video unavailable…"
          : "No captions available…";
    sendEvent("stage", { text: stageText });
    searchMessages = [
      {
        role: "system",
        content: `${WEB_SEARCH_SYSTEM_PROMPT}\n\n${transcriptUnavailableNote(yt.unavailable, yt.url)}`,
      },
      ...messages,
    ];
  }

  // One streamed completion turn. Appends text/reasoning into the shared
  // buffers (persisted + forwarded live) and collects tool_calls deltas.
  // terminal:true means an error was already sent — the caller must return.
  const runTurn = async (
    turnMessages: OpenRouterMessage[]
  ): Promise<{ usage: any; toolCalls: PendingToolCall[]; terminal: boolean }> => {
    const pending: PendingToolCall[] = [];
    const useWebTool = webSearch === true && research !== true;
    const webTools = useWebTool
      ? [
          {
            type: "openrouter:web_search",
            parameters: { engine: "auto", max_results: searchDepth },
          },
        ]
      : [];
    const toolsForTurn = await loadCanvaTools();
    // Model-driven search: when the server did NOT pre-inject results for
    // this turn, offer the model its own parallel web-search tool so it can
    // pull fresh facts itself (including follow-up searches mid-turn).
    // Pre-searched turns skip it — no duplicate provider spend.
    const modelSearchTools =
      research !== true && searchMessages === messages ? [getWebSearchToolDef()] : [];
    // Model-driven app tools (quiz / simulation / artifact): offered on plain
    // text turns so the model itself routes "quiz me on this", "simulate X",
    // "build me a page" to the right renderer. Research and artifact turns
    // have their own dedicated pipelines and prompts.
    const appTools = !research && !artifact ? getAppToolDefs() : [];
    const routingHead = appTools.length > 0 ? APP_ROUTING_SYSTEM : null;
    const requestBody: Record<string, unknown> = {
      model: selectedModel,
      messages: research
        ? [{ role: "system", content: RESEARCH_SYSTEM_PROMPT }, ...turnMessages]
        : useWebTool || routingHead
          ? [
              {
                role: "system",
                content: [routingHead, useWebTool ? WEB_SEARCH_SYSTEM_PROMPT : null]
                  .filter(Boolean)
                  .join("\n\n"),
              },
              ...turnMessages,
            ]
          : turnMessages,
      ...(webTools.length > 0 || toolsForTurn.length > 0 || modelSearchTools.length > 0 || appTools.length > 0
        ? { tools: [...webTools, ...toolsForTurn, ...modelSearchTools, ...appTools], tool_choice: "auto" }
        : {}),
      stream: true,
    };
    if (research) {
      // Deep-research reports run 2000-3000 words plus reasoning trace —
      // raise the ceiling well above the old 8000 so reports finish.
      requestBody.max_tokens = 16000;
    }
    if (artifact) {
      // Artifact turns emit a full standalone HTML document — a provider
      // default cap (often 1–4k) truncates simulations mid-code. Raise the
      // ceiling so the document finishes through </html> + closing fence.
      requestBody.max_tokens = TOKEN.ARTIFACT_MAX_TOKENS;
    }
    if (!research && !artifact) {
      // Normal turns: provider defaults can cut answers short — always send
      // an explicit budget (small-model 400s retry uncapped below).
      requestBody.max_tokens = TOKEN.OPENROUTER_DEFAULT_MAX_TOKENS;
    }
    if (research || think) {
      // Deep-research and "Thinking" mode runs stream thinking tokens before
      // the synthesis; request + forward them (no server timeout is imposed —
      // the stream stays open until the model finishes or the client drops).
      requestBody.include_reasoning = true;
    }
    let lastRequestBody: Record<string, unknown> = requestBody;
    let response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_ORIGIN,
        "X-Title": "ChatUI",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    // Web-search edge case: the selected model may reject tool calling
    // entirely. Retry once WITHOUT the web tool and tell the client to note
    // "search unavailable, answering from general knowledge".
    if (!response.ok && useWebTool) {
      const { logger: svcLogger } = await import("../../lib/logger");
      svcLogger.warn({ status: response.status }, "OpenRouter web-search turn failed, retrying without tools");
      searchNotice =
        "Web search isn't available for the selected model — answering from general knowledge.";
      const toolsForFallback = await loadCanvaTools();
      const fallbackBody: Record<string, unknown> = {
        model: selectedModel,
        messages: [
          { role: "system", content: WEB_SEARCH_SYSTEM_PROMPT },
          ...turnMessages,
        ],
        stream: true,
        ...(artifact ? { max_tokens: TOKEN.ARTIFACT_MAX_TOKENS } : { max_tokens: TOKEN.OPENROUTER_DEFAULT_MAX_TOKENS }),
        ...(toolsForFallback.length > 0 ? { tools: toolsForFallback, tool_choice: "auto" } : {}),
      };
      response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.APP_ORIGIN,
          "X-Title": "ChatUI",
        },
        body: JSON.stringify(fallbackBody),
        signal: controller.signal,
      });
      lastRequestBody = fallbackBody;
    }
    // Output-ceiling rejection (small-context models 400 on the explicit
    // max_tokens): retry once with NO ceiling so the turn answers instead of
    // failing. The probe consumes the body — stashed for the error read below.
    let prefetchedOpenRouterError: string | null = null;
    if (
      !response.ok &&
      !controller.signal.aborted &&
      (response.status === 400 || response.status === 422 || response.status === 413)
    ) {
      try {
        prefetchedOpenRouterError = await response.text();
      } catch {
        prefetchedOpenRouterError = "";
      }
      if (isTokenLimitRejection(response.status, prefetchedOpenRouterError)) {
        const { logger: svcLoggerRetry } = await import("../../lib/logger");
        svcLoggerRetry.warn({ status: response.status }, "OpenRouter ceiling rejected, retrying uncapped once");
        delete lastRequestBody.max_tokens;
        response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": env.APP_ORIGIN,
            "X-Title": "ChatUI",
          },
          body: JSON.stringify(lastRequestBody),
          signal: controller.signal,
        });
        prefetchedOpenRouterError = null;
      }
    }
    const { logger: svcLogger2 } = await import("../../lib/logger");
    svcLogger2.info({ status: response.status }, "OpenRouter response status");
    if (!response.ok || !response.body) {
      const errorText = prefetchedOpenRouterError ?? await response.text();
      svcLogger2.error({ errorText: errorText.slice(0, 2000) }, "OpenRouter error");
      await prisma.message.update({ where: { id: assistantMessageId }, data: { status: "ERROR", error: errorText } });
      sendEvent("error", { code: "OPENROUTER_ERROR", message: `OpenRouter error: ${errorText}` });
      safeEnd();
      return { usage: null, toolCalls: [], terminal: true };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let usage: any = null;
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.replace(/^data:\s*/, "");
        if (data === "[DONE]") {
          done = true;
          break;
        }
        try {
          const parsed = JSON.parse(data);
          collectAnnotations(parsed);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            assistantContent += delta;
            if (assistantContent.length >= 300) kickFollowups(assistantContent);
            sendEvent("token", { delta });
          }
          const fr = parsed.choices?.[0]?.finish_reason;
          if (typeof fr === "string" && fr) stopReason = fr;
          // Thinking stream: forwarded live for the reasoning accordion —
          // deep-research turns ONLY. Web-search/normal turns never show
          // a reasoning process, even if the model emits thinking tokens.
          const reasoning =
            parsed.choices?.[0]?.delta?.reasoning ??
            parsed.choices?.[0]?.delta?.reasoning_content;
          if (allowReasoning && typeof reasoning === "string" && reasoning.length > 0) {
            assistantReasoning += reasoning;
            sendEvent("reasoning", { delta: reasoning });
          }
          // Connector tool calls (Canva): accumulate index-keyed deltas so
          // the turn below can execute them and stream the final answer.
          const toolCallDeltas = parsed.choices?.[0]?.delta?.tool_calls;
          if (Array.isArray(toolCallDeltas)) {
            for (const tc of toolCallDeltas) {
              const idx = typeof tc?.index === "number" ? tc.index : 0;
              if (!pending[idx]) pending[idx] = { id: "", name: "", arguments: "" };
              if (typeof tc?.id === "string") pending[idx].id += tc.id;
              if (typeof tc?.function?.name === "string") pending[idx].name += tc.function.name;
              if (typeof tc?.function?.arguments === "string") {
                pending[idx].arguments += tc.function.arguments;
              }
            }
          }
          if (parsed.usage) usage = parsed.usage;
        } catch {
          // ignore malformed chunks
        }
      }
      const now = Date.now();
      if (
        assistantContent.length + assistantReasoning.length - lastPersistedLength >= 200 ||
        now - lastPersistedAt > 1000
      ) {
        lastPersistedLength = assistantContent.length + assistantReasoning.length;
        lastPersistedAt = now;
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: { content: assistantContent, reasoning: allowReasoning ? assistantReasoning || null : null },
        });
      }
    }
    return { usage, toolCalls: pending, terminal: false };
  };

  try {
    let turnMessages = searchMessages;
    let usage: any = null;
    // First UI payload from an app tool wins (routing rule: at most one per
    // turn). Rendered after the loop: quiz → quiz event + row, artifact →
    // ```html:artifact fence the existing panel picks up.
    let pendingUi: AppToolUi | null = null;
    // At most one tool round-trip: turn 0 may request tool calls, turn 1
    // streams the final answer with their results in context (this is also
    // the single retry a failed app-tool validation gets). When no tools are
    // requested this loop runs exactly once, as before.
    for (let turn = 0; ; turn += 1) {
      const result = await runTurn(turnMessages);
      if (result.terminal) return;
      usage = result.usage ?? usage;
      const requested = result.toolCalls.filter((c) => c.name).slice(0, MAX_PARALLEL_TOOL_CALLS);
      if (requested.length === 0 || turn >= 1) break;
      // Web search and app tools are built-in and work without connectors.
      // App tools (quiz/simulation/artifact) execute server-side, validated.
      // Connector calls still require a linked account (and at least one
      // resolved tool) before they are attempted.
      const appRequested = requested.filter((c) => isAppToolName(c.name));
      let connectorRequested = requested.filter(
        (c) => !c.name.startsWith("web__") && !isAppToolName(c.name)
      );
      const toolsResolved = connectorRequested.length > 0 ? await loadCanvaTools() : [];
      if (connectorRequested.length > 0 && (toolsResolved.length === 0 || !canvaUserId)) {
        // Connectors unavailable: still honor app tools in this batch.
        if (appRequested.length === 0) break;
        connectorRequested = [];
      }
      const uid = canvaUserId ?? (req as any).user?.id;
      if (!uid) break;
      // Live phase for the client status line; unknown to older clients,
      // which safely ignore unrecognized SSE event types.
      sendEvent("tools", { names: requested.map((c) => c.name) });
      // App tools run first — validation errors return to the model as tool
      // results so turn 1 can fix the call (spec: one retry).
      const appResults: Array<{ id: string; text: string }> = [];
      for (const tc of appRequested) {
        const r = await executeAppTool(tc.name, tc.arguments, { userId: uid, model: selectedModel });
        appResults.push({ id: tc.id, text: r.resultText });
        if (r.ui && !pendingUi) pendingUi = r.ui;
      }
      // Connector/web tools fan out concurrently — wall-clock is the slowest
      // tool, not the sum.
      const toolResults =
        connectorRequested.length > 0 ? await executeToolCallsParallel(uid, [
          ...connectorRequested,
          ...requested.filter((c) => c.name.startsWith("web__")),
        ]) : [];
      // A model-initiated web search must populate the same source list as the
      // server's pre-search path, otherwise the answer has no URLs to show.
      for (const toolResult of toolResults) {
        const found = toolResult.sources ?? [];
        found.forEach((s, i) =>
          sendEvent("stage", {
            text: stageLineForSource(i, found.length, s.title, s.url, s.snippet),
          })
        );
        for (const s of found) {
          if (!sourceMap.has(s.url)) {
            sourceMap.set(s.url, {
              url: s.url,
              title: s.title,
              ...(s.image ? { image: s.image } : {}),
            });
          }
        }
      }
      if (controller.signal.aborted) {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: assistantContent,
            reasoning: allowReasoning ? assistantReasoning || null : null,
            status: "COMPLETE",
            model: selectedModel,
            durationMs: Date.now() - startedAt,
          },
        });
        await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
        return safeEnd();
      }
      // The final answer streams fresh in the next turn.
      assistantContent = "";
      assistantReasoning = "";
      lastPersistedLength = 0;
      turnMessages = [
        ...turnMessages,
        {
          role: "assistant",
          content: "",
          tool_calls: requested.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        ...[...appResults, ...toolResults].map((r) => ({
          role: "tool",
          tool_call_id: r.id,
          content: r.text,
        })),
      ] as unknown as OpenRouterMessage[];
    }
    // UI payload from an app tool: render through the existing surfaces.
    let quizForFinal: ReturnType<typeof mcqQuizPayload> | null = null;
    if (pendingUi) {
      if (pendingUi.kind === "mcq") {
        let round = 1;
        try {
          round =
            (await (prisma.message as any).count({
              where: { conversationId, NOT: { quiz: null } },
            })) + 1;
        } catch {
          round = 1;
        }
        quizForFinal = mcqQuizPayload(pendingUi, round);
        sendEvent("quiz", { messageId: assistantMessageId, quiz: quizForFinal });
      } else {
        const lead = assistantContent.trim() ? "\n\n" : "";
        const fence = `${lead}${artifactFenceOf(pendingUi)}`;
        assistantContent += fence;
        sendEvent("token", { delta: fence });
      }
    }
    const sources = [...sourceMap.values()];
    // Limit-stop honesty: the provider ran out of output budget mid-answer.
    // Name it inline so a severed sentence is never mistaken for complete.
    if (stopReason === "length" && assistantContent) {
      assistantContent += "\n\n…[cut off at the output limit — send “continue” for the rest]";
      sendEvent("token", { delta: "\n\n…[cut off at the output limit — send “continue” for the rest]" });
    }
    // Bottom links render from the persisted `sources` row (client plain
    // list) — no body footer, so URLs never appear twice. A model-written
    // trailing Sources section is still swapped for the canonical URL list
    // so the bubble never shows two lists either.
    assistantContent = ensureSingleSourcesSection(assistantContent, sources, false);
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: assistantContent,
        reasoning: allowReasoning ? assistantReasoning || null : null,
        status: "COMPLETE",
        model: selectedModel,
        ...(quizForFinal ? { quiz: quizForFinal } : {}),
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        tokenCount: usage?.total_tokens,
        durationMs: Date.now() - startedAt,
        ...(sources.length > 0
          ? { usedSearch: true, sources }
          : { usedSearch: false }),
      },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    if (sources.length > 0) {
      sendEvent("sources", { messageId: assistantMessageId, sources });
    }
    if (searchNotice) {
      // system_notice style event: render as a dismissible inline banner.
      sendEvent("notice", { message: searchNotice });
    }
    sendEvent("done", { messageId: assistantMessageId, usage: usage || {}, durationMs: Date.now() - startedAt });
    // Best-effort follow-up questions (never fails the stream). Skipped
    // entirely when the user turned follow-ups off in Settings. Generation
    // started mid-stream (see kickFollowups) so this await is usually
    // already resolved — short answers kick off here as a fallback.
    try {
      if (!followupsPromise) kickFollowups(assistantContent);
      const followups = await followupsPromise!;
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: { followups },
        });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      const { logger: svcLogger3 } = await import("../../lib/logger");
      svcLogger3.error({ err }, "Followups error");
    }
    return safeEnd();
  } catch (err: any) {
    if (controller.signal.aborted) {
      await prisma.message.update({
        where: { id: assistantMessageId },
        data: {
          content: assistantContent,
          reasoning: allowReasoning ? assistantReasoning || null : null,
          status: "COMPLETE",
          model: selectedModel,
          durationMs: Date.now() - startedAt,
        },
      });
      await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      return safeEnd();
    }
    const { logger: svcLogger4 } = await import("../../lib/logger");
    svcLogger4.error({ err }, "Stream error");
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: err?.message || "Stream error" },
    });
    sendEvent("error", { code: "STREAM_ERROR", message: "Streaming failed" });
    return safeEnd();
  }
};

// Compat re-exports: chat.routes imports these from ./chat.service.
export { sseHead, sseSend, sseEnd, finishTextReply, sendSimpleTextFinish } from "./sse";
export { wantsImageGeneration, wantsVideo, wantsVideoGeneration, MAX_VIDEOS } from "./intents";
export { wantsMcq } from "./mcq";
export { generateFollowups } from "./followups";
export { sendMcqReply, mcqSchema, hashQuestion } from "./mcq";
export type { McqReplyOpts } from "./mcq";
export { sendImageReply, sendVideoReply } from "./mediaReply";
export { wantsArtifact, ARTIFACT_SYSTEM_PROMPT, ARTIFACT_INTENT } from "./artifact";
