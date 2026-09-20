// SSE framing + plain-text finish helpers — split from chat.service.ts. No logic changes.
import { prisma } from "../../lib/prisma";

export const sseHead = (res: any) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
};
export const sseSend = (res: any) => (event: string, data: unknown) => {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};
export const sseEnd = (res: any) => () => {
  if (!res.writableEnded && !res.destroyed) res.end();
};

// Shared finish: persist plain text on the assistant message + emit token/done.
// Extracted so sendImageReply / sendMcqReply / routes empty-topic path share it.
export const finishTextReply = async (
  _res: any,
  opts: {
    assistantMessageId: string;
    conversationId: string;
    selectedModel: string;
    text: string;
    sendEvent: (event: string, data: unknown) => void;
    safeEnd: () => void;
  }
) => {
  const { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd } = opts;
  await prisma.message.update({
    where: { id: assistantMessageId },
    data: { content: text, status: "COMPLETE", model: selectedModel },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  sendEvent("token", { delta: text });
  sendEvent("done", { messageId: assistantMessageId, usage: {} });
  return safeEnd();
};

// One-call variant for callers that have not started SSE yet (e.g. routes
// empty-topic guard). Does sseHead + finishTextReply.
export const sendSimpleTextFinish = async (
  _req: any,
  res: any,
  opts: { assistantMessageId: string; conversationId: string; selectedModel: string; text: string }
) => {
  const { assistantMessageId, conversationId, selectedModel, text } = opts;
  sseHead(res);
  const sendEvent = sseSend(res);
  const safeEnd = sseEnd(res);
  return finishTextReply(res, { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd });
};
