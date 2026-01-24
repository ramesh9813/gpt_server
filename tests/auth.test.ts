import request from "supertest";
import app from "../src/app";
import { clearDb, prisma } from "./helpers";

describe("auth flow", () => {
  beforeAll(async () => {
    await clearDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("signs up and logs in", async () => {
    const email = `user_${Date.now()}@example.com`;
    const signup = await request(app).post("/api/auth/signup").send({
      email,
      password: "StrongPass123!",
      name: "Test"
    });

    expect(signup.status).toBe(201);
    expect(signup.body.success).toBe(true);
    expect(signup.headers["set-cookie"]).toBeDefined();

    const login = await request(app).post("/api/auth/login").send({
      email,
      password: "StrongPass123!"
    });

    expect(login.status).toBe(200);
    expect(login.body.success).toBe(true);
    expect(login.headers["set-cookie"]).toBeDefined();
  });
});