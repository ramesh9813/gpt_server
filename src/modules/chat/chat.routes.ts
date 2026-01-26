import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { env } from "../../lib/config";

const router = Router();

const streamSchema = z.object({
  conversationId: z.string(),
  userMessage: z.string().min(1).max(8000).optional(),
  existingUserMessageId: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional()
})
.refine((data) => data.userMessage || data.existingUserMessageId, {
  message: "userMessage or existingUserMessageId is required"
})
.refine((data) => !(data.userMessage && data.existingUserMessageId), {
  message: "Provide either userMessage or existingUserMessageId"
});

type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const mapRole = (role: string): OpenRouterMessage["role"] => {
  if (role === "SYSTEM") return "system";
  if (role === "ASSISTANT") return "assistant";
  return "user";
};

router.post(
  "/stream",
  requireAuth,
  validateBody(streamSchema),
  async (req, res) => {
    const {
      conversationId,
      userMessage,
      existingUserMessageId,
      model,
      systemPrompt
    } = req.body;

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        userId: req.user!.id,
        deletedAt: null
      }
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" }
      });
    }

    let userMsgContent = userMessage || "";
    if (existingUserMessageId) {
      const existingMessage = await prisma.message.findFirst({
        where: {
          id: existingUserMessageId,
          conversationId,
          role: "USER"
        }
      });

      if (!existingMessage) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Message not found" }
        });
      }

      userMsgContent = existingMessage.content;
    } else if (userMessage) {
      const userMsg = await prisma.message.create({
        data: {
          conversationId,
          role: "USER",
          content: userMessage,
          status: "COMPLETE"
        }
      });
    }

    const trimmedTitle = userMsgContent.trim().replace(/\s+/g, " ");
    if (conversation.title === "New chat" && trimmedTitle.length > 0) {
      const derivedTitle =
        trimmedTitle.length > 60
          ? `${trimmedTitle.slice(0, 57)}...`
          : trimmedTitle;
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { title: derivedTitle }
      });
    }

    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" }
    });

    const assistantMsg = await prisma.message.create({
      data: {
        conversationId,
        role: "ASSISTANT",
        content: "",
        status: "STREAMING"
      }
    });

    const messages: OpenRouterMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    for (const message of history) {
      messages.push({ role: mapRole(message.role), content: message.content });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    let assistantContent = "";
    let lastPersistedLength = 0;
    let lastPersistedAt = Date.now();

    console.log("Sending messages to OpenRouter:", JSON.stringify(messages, null, 2));

    try {
      const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.APP_ORIGIN,
          "X-Title": "ChatUI"
        },
        body: JSON.stringify({
          model: model || env.OPENROUTER_MODEL_DEFAULT,
          messages,
          stream: true
        }),
        signal: controller.signal
      });

      console.log("OpenRouter Response Status:", response.status, response.statusText);

      if (!response.ok || !response.body) {
        const errorText = await response.text();
        console.error("OpenRouter Error:", errorText);
        await prisma.message.update({
          where: { id: assistantMsg.id },
          data: { status: "ERROR", error: errorText }
        });
        sendEvent("error", {
          code: "OPENROUTER_ERROR",
          message: `OpenRouter error: ${errorText}`
        });
        return res.end();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      let usage: any = null;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) {
          break;
        }

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
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              assistantContent += delta;
              sendEvent("token", { delta });
            }
            if (parsed.usage) {
              usage = parsed.usage;
            }
          } catch {
            // ignore malformed chunks
          }
        }

        const now = Date.now();
        if (
          assistantContent.length - lastPersistedLength >= 200 ||
          now - lastPersistedAt > 1000
        ) {
          lastPersistedLength = assistantContent.length;
          lastPersistedAt = now;
          await prisma.message.update({
            where: { id: assistantMsg.id },
            data: { content: assistantContent }
          });
        }
      }

      await prisma.message.update({
        where: { id: assistantMsg.id },
        data: {
          content: assistantContent,
          status: "COMPLETE",
          model: model || env.OPENROUTER_MODEL_DEFAULT,
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
          tokenCount: usage?.total_tokens
        }
      });

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() }
      });

      sendEvent("done", { messageId: assistantMsg.id, usage: usage || {} });
      return res.end();
    } catch (err: any) {
      console.error("Stream error:", err);
      await prisma.message.update({
        where: { id: assistantMsg.id },
        data: { status: "ERROR", error: err?.message || "Stream error" }
      });
      sendEvent("error", {
        code: "STREAM_ERROR",
        message: "Streaming failed"
      });
      return res.end();
    }
  }
);

export default router;
