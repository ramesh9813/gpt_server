import request from "supertest";
import app from "../src/app";
import { clearDb, prisma } from "./helpers";

const getCookie = (setCookie: string[], name: string) => {
  const cookie = setCookie.find((c) => c.startsWith(`${name}=`));
  if (!cookie) return "";
  return cookie.split(";")[0];
};

describe("POST /api/byok/validate", () => {
  beforeAll(async () => {
    await clearDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const signup = async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: `byok_${Date.now()}_${Math.random()}@example.com`,
      password: "StrongPass123!",
      name: "Byok",
    });
    const cookies = res.headers["set-cookie"] as string[];
    return {
      access: getCookie(cookies, "accessToken"),
      refresh: getCookie(cookies, "refreshToken"),
      csrf: getCookie(cookies, "csrfToken").split("=")[1],
    };
  };

  it("reports unsupported for a bad key format (no network call)", async () => {
    const { access, refresh, csrf } = await signup();
    const res = await request(app)
      .post("/api/byok/validate")
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({ provider: "openai", apiKey: "not-a-key" });

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(false);
    expect(res.body.data.verified).toBe(false);
  });

  it("verifies a well-formed key and returns live models", async () => {
    const { access, refresh, csrf } = await signup();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "whisper-1" }],
      }),
    });

    const res = await request(app)
      .post("/api/byok/validate")
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({ provider: "openai", apiKey: "sk-" + "a".repeat(48) });

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(true);
    expect(res.body.data.verified).toBe(true);
    // whisper is filtered out for OpenAI (non-chat family)
    expect(res.body.data.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("surfaces provider rejection as unsupported", async () => {
    const { access, refresh, csrf } = await signup();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });

    const res = await request(app)
      .post("/api/byok/validate")
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({ provider: "grok", apiKey: "xai-" + "c".repeat(80) });

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(false);
  });

  it("returns live model ids from POST /api/byok/models (keyless provider)", async () => {
    const { access, refresh, csrf } = await signup();
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "meta/llama-3.3-70b-instruct" }, { id: "nvidia/nemotron" }],
      }),
    });

    const res = await request(app)
      .post("/api/byok/models")
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({ provider: "nvidia" });

    expect(res.status).toBe(200);
    expect(res.body.data.models).toEqual([
      "meta/llama-3.3-70b-instruct",
      "nvidia/nemotron",
    ]);
  });

  it("rejects unknown providers with 400", async () => {
    const { access, refresh, csrf } = await signup();
    const res = await request(app)
      .post("/api/byok/validate")
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({ provider: "acme", apiKey: "whatever-12345678901234567890" });

    expect(res.status).toBe(400);
  });
});
