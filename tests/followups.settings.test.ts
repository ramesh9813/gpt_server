// Follow-ups settings toggle: off means no follow-ups, default (missing /
// error / no row) means on.
/// <reference types="jest" />
import { isFollowupsEnabled } from "../src/modules/chat/followups";
import { prisma } from "../src/lib/prisma";

jest.mock("../src/lib/prisma", () => ({
  prisma: { userSettings: { findUnique: jest.fn() } },
}));

const findUnique = prisma.userSettings.findUnique as unknown as jest.Mock;

describe("isFollowupsEnabled", () => {
  beforeEach(() => findUnique.mockReset());

  it("is on when the row is missing", async () => {
    findUnique.mockResolvedValue(null);
    await expect(isFollowupsEnabled("u1")).resolves.toBe(true);
  });

  it("is on when the flag is missing or true", async () => {
    findUnique.mockResolvedValue({ userId: "u1" });
    await expect(isFollowupsEnabled("u1")).resolves.toBe(true);
    findUnique.mockResolvedValue({ userId: "u1", showFollowups: true });
    await expect(isFollowupsEnabled("u1")).resolves.toBe(true);
  });

  it("is off only on explicit false", async () => {
    findUnique.mockResolvedValue({ userId: "u1", showFollowups: false });
    await expect(isFollowupsEnabled("u1")).resolves.toBe(false);
  });

  it("is on when the lookup fails", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    await expect(isFollowupsEnabled("u1")).resolves.toBe(true);
  });

  it("is on without a user id", async () => {
    await expect(isFollowupsEnabled("")).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
