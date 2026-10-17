/// <reference types="jest" />
// Smoke: basic route modules load (split from routes.smoke for low-memory
// environments — each file keeps its own small module graph).
jest.mock("../src/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => () => ({}) }),
}));

describe("basic route modules load", () => {
  it("conversations/folders/users routes import", async () => {
    const conv = await import("../src/modules/conversations/conversations.routes");
    const fold = await import("../src/modules/folders/folders.routes");
    const users = await import("../src/modules/users/users.routes");
    expect(typeof conv.default).toBe("function");
    expect(typeof fold.default).toBe("function");
    expect(typeof users.default).toBe("function");
  });
});
