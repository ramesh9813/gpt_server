// Smoke: edited route/service modules load (typecheck + import graph).
/// <reference types="jest" />
jest.mock("../src/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => () => ({}) }),
}));

describe("route modules load", () => {
  it("conversations/folders/users routes import", async () => {
    const conv = await import("../src/modules/conversations/conversations.routes");
    const fold = await import("../src/modules/folders/folders.routes");
    const users = await import("../src/modules/users/users.routes");
    expect(typeof conv.default).toBe("function");
    expect(typeof fold.default).toBe("function");
    expect(typeof users.default).toBe("function");
  });
  it("chat service + stream modules import", async () => {
    const svc = await import("../src/modules/chat/chat.service");
    const router = await import("../src/modules/chat/chat.streamRouter");
    const fu = await import("../src/modules/chat/followups");
    expect(typeof svc.streamOpenRouterCompletion).toBe("function");
    expect(typeof router.handleStream).toBe("function");
    expect(typeof fu.isFollowupsEnabled).toBe("function");
  });
});
