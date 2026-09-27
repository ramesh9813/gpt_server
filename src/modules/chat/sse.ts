import { Response, Request } from "express";
import { prisma } from "../../lib/prisma";

export type SseResponse = Response & {
  writeHead: Response["writeHead"];
  write: Response["write"];
  end: Response["end"];
  writableEnded: boolean;
  destroyed: boolean;
};

export const sseHead = (res: Response): void => {
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
};
export const sseSend =
  (res: Response): ((event: string, data: unknown) => void) =>
  (event: string, data: unknown) => {
    const r = res as SseResponse;
    if (r.writableEnded || r.destroyed) return;
    r.write(`event: ${event}\n`);
    r.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      (r as unknown as { flush?: () => void }).flush?.();
    } catch {}
  };
export const sseEnd =
  (res: Response): (() => void) =>
  () => {
    const r = res as SseResponse;
    if (!r.writableEnded && !r.destroyed) r.end();
  };

// Shared finish: persist plain text on the assistant message + emit token/done.
// Extracted so sendImageReply / sendMcqReply / routes empty-topic path share it.
export const finishTextReply = async (
  _res: Response,
  opts: {
    assistantMessageId: string;
    conversationId: string;
    selectedModel: string;
    text: string;
    sendEvent: (event: string, data: unknown) => void;
    safeEnd: () => void;
    startedAt?: number;
  }
): Promise<void> => {
  const { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd, startedAt } = opts;
  const durationMs = typeof startedAt === "number" ? Date.now() - startedAt : undefined;
  await prisma.message.update({
    where: { id: assistantMessageId },
    data: { content: text, status: "COMPLETE", model: selectedModel, ...(durationMs !== undefined ? { durationMs } : {}) },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  sendEvent("token", { delta: text });
  sendEvent("done", { messageId: assistantMessageId, usage: {}, ...(durationMs !== undefined ? { durationMs } : {}) });
  return safeEnd();
};

// One-call variant for callers that have not started SSE yet (e.g. routes
// empty-topic guard). Does sseHead + finishTextReply.
export const sendSimpleTextFinish = async (
  _req: Request,
  res: Response,
  opts: { assistantMessageId: string; conversationId: string; selectedModel: string; text: string }
): Promise<void> => {
  const { assistantMessageId, conversationId, selectedModel, text } = opts;
  sseHead(res);
  const sendEvent = sseSend(res);
  const safeEnd = sseEnd(res);
  return finishTextReply(res, { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd });
};
