import request from "supertest";
import app from "../src/app";
import { clearDb, prisma } from "./helpers";
import {
  BYOK_PROVIDERS,
  getByokProvider,
  isByokKeyFormatSupported,
} from "../src/lib/byok";

const getCookie = (setCookie: string[], name: string) => {
  const cookie = setCookie.find((c) => c.startsWith(`${name}=`));
  if (!cookie) return "";
  return cookie.split(";")[0];
};

describe("byok provider registry", () => {
  it("exposes all five providers", () => {
    expect(Object.keys(BYOK_PROVIDERS).sort()).toEqual([
      "google",
      "grok",
      "meta",
      "nvidia",
      "openai",
    ]);
  });

  it("resolves providers case-insensitively and rejects unknown ids", () => {
    expect(getByokProvider("OpenAI")?.id).toBe("openai");
    expect(getByokProvider("nvidia")?.id).toBe("nvidia");
    expect(getByokProvider("acme")).toBeNull();
    expect(getByokProvider(undefined)).toBeNull();
  });

  it("checks key formats per provider", () => {
    const openai = getByokProvider("openai")!;
    expect(isByokKeyFormatSupported(openai, "sk-" + "a".repeat(48))).toBe(true);
    expect(isByokKeyFormatSupported(openai, "AIzaSy" + "b".repeat(33))).toBe(false);
    expect(isByokKeyFormatSupported(openai, "hello")).toBe(false);

    const google = getByokProvider("google")!;
    expect(isByokKeyFormatSupported(google, "AIzaSy" + "b".repeat(33))).toBe(true);
    expect(isByokKeyFormatSupported(google, "sk-" + "a".repeat(48))).toBe(false);

    const grok = getByokProvider("grok")!;
    expect(isByokKeyFormatSupported(grok, "xai-" + "c".repeat(80))).toBe(true);
    expect(isByokKeyFormatSupported(grok, "sk-" + "a".repeat(48))).toBe(false);

    const nvidia = getByokProvider("nvidia")!;
    expect(isByokKeyFormatSupported(nvidia, "nvapi-" + "d".repeat(40))).toBe(true);

    const meta = getByokProvider("meta")!;
    expect(isByokKeyFormatSupported(meta, "LLM|1234567890|abcdef")).toBe(true);
  });
});

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
