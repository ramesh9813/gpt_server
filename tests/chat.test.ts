import request from "supertest";
import app from "../src/app";
import { clearDb, prisma } from "./helpers";

const getCookie = (setCookie: string[], name: string) => {
  const cookie = setCookie.find((c) => c.startsWith(`${name}=`));
  if (!cookie) return "";
  return cookie.split(";")[0];
};

describe("chat stream", () => {
  beforeAll(async () => {
    await clearDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns SSE headers", async () => {
    const email = `chat_${Date.now()}@example.com`;
    const signup = await request(app).post("/api/auth/signup").send({
      email,
      password: "StrongPass123!",
      name: "Chat"
    });

    const cookies = signup.headers["set-cookie"] as string[];
    const access = getCookie(cookies, "accessToken");
    const refresh = getCookie(cookies, "refreshToken");
    const csrf = getCookie(cookies, "csrfToken").split("=")[1];

    const create = await request(app)
      .post("/api/conversations")
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({});

    const conversationId = create.body.data.conversation.id;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n"
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: stream
    });

    const response = await request(app)
      .post("/api/chat/stream")
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({
        conversationId,
        userMessage: "Hi"
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });
});