/// <reference types="jest" />
// Smoke: chat service + stream modules load (split from routes.smoke for
// low-memory environments — the chat graph is the heaviest import chain).
jest.mock("../src/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => () => ({}) }),
}));

describe("chat modules load", () => {
  it("chat service imports", async () => {
    const svc = await import("../src/modules/chat/chat.service");
    expect(typeof svc.streamOpenRouterCompletion).toBe("function");
  });

  it("stream router imports", async () => {
    const router = await import("../src/modules/chat/chat.streamRouter");
    expect(typeof router.handleStream).toBe("function");
  });

  it("followups imports", async () => {
    const fu = await import("../src/modules/chat/followups");
    expect(typeof fu.isFollowupsEnabled).toBe("function");
  });
});
