import request from "supertest";
import app from "../src/app";
import { clearDb, prisma } from "./helpers";

const getCookie = (setCookie: string[], name: string) => {
  const cookie = setCookie.find((c) => c.startsWith(`${name}=`));
  if (!cookie) return "";
  return cookie.split(";")[0];
};

describe("conversation CRUD", () => {
  beforeAll(async () => {
    await clearDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates, renames, and deletes a conversation", async () => {
    const email = `conv_${Date.now()}@example.com`;
    const signup = await request(app).post("/api/auth/signup").send({
      email,
      password: "StrongPass123!",
      name: "Conv"
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

    expect(create.status).toBe(201);
    const conversationId = create.body.data.conversation.id;

    const rename = await request(app)
      .patch(`/api/conversations/${conversationId}`)
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf)
      .send({ title: "Renamed" });

    expect(rename.status).toBe(200);

    const del = await request(app)
      .delete(`/api/conversations/${conversationId}`)
      .set("Cookie", [access, refresh, `csrfToken=${csrf}`])
      .set("x-csrf-token", csrf);

    expect(del.status).toBe(200);
  });
});