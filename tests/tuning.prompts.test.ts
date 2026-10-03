// Todo-list tuning: prompt lists, legacy migration, folder merge + mutes.
/// <reference types="jest" />
import {
  activePromptTexts,
  legacyMirrorOf,
  mergePromptLists,
  mutedIdsFromRow,
  normalizePromptList,
  promptsFromRow,
} from "../src/lib/tuning";

describe("normalizePromptList", () => {
  it("keeps ids, drops empties, caps length", () => {
    const list = normalizePromptList([
      { id: "a", text: "  first  ", enabled: true },
      { id: "b", text: "", enabled: true },
      { text: "second", enabled: false },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: "a", text: "first", enabled: true });
    expect(list[1].text).toBe("second");
    expect(list[1].enabled).toBe(false);
    expect(typeof list[1].id).toBe("string");
  });
  it("migrates a legacy single prompt", () => {
    expect(normalizePromptList(null, "old prompt", true)).toHaveLength(1);
    expect(normalizePromptList(undefined, "old prompt", false)[0].enabled).toBe(false);
    expect(normalizePromptList(null, null, true)).toHaveLength(0);
    expect(normalizePromptList([], "  ", true)).toHaveLength(0);
  });
});

describe("promptsFromRow / mutedIdsFromRow", () => {
  it("reads the new columns with legacy fallback", () => {
    const row = { customPrompts: [{ id: "x", text: "hi", enabled: true }] };
    expect(promptsFromRow(row)).toHaveLength(1);
    expect(promptsFromRow({ customPrompt: "legacy", customPromptEnabled: true })[0].text).toBe("legacy");
    expect(promptsFromRow({})).toHaveLength(0);
    expect(promptsFromRow(null)).toHaveLength(0);
  });
  it("reads muted ids safely", () => {
    expect(mutedIdsFromRow({ mutedFolderPromptIds: ["a", 1, ""] })).toEqual(["a"]);
    expect(mutedIdsFromRow({})).toEqual([]);
  });
});

describe("mergePromptLists", () => {
  const folder = [
    { id: "f1", text: "folder one", enabled: true },
    { id: "f2", text: "folder two", enabled: false },
  ];
  const chat = [{ id: "c1", text: "chat one", enabled: true }];

  it("puts folder prompts first, skips disabled", () => {
    const out = mergePromptLists("base", folder, chat, [])!;
    expect(out.startsWith("base")).toBe(true);
    expect(out).toContain("folder one");
    expect(out).not.toContain("folder two");
    expect(out).toContain("chat one");
    expect(out.indexOf("folder one")).toBeLessThan(out.indexOf("chat one"));
  });
  it("honors per-chat mutes of folder prompts", () => {
    const out = mergePromptLists(undefined, folder, chat, ["f1"])!;
    expect(out).not.toContain("folder one");
    expect(out).toContain("chat one");
  });
  it("matches legacy single-prompt output for one item", () => {
    const single = mergePromptLists("base", [], [{ id: "c", text: "only", enabled: true }], [])!;
    expect(single).toContain("base");
    expect(single).toContain("only");
  });
  it("returns base/undefined when nothing is active", () => {
    expect(mergePromptLists("base", [], [], [])).toBe("base");
    expect(mergePromptLists(undefined, [], [], [])).toBeUndefined();
  });
});

describe("legacyMirrorOf", () => {
  it("mirrors enabled texts for old clients", () => {
    expect(legacyMirrorOf([])).toEqual({ customPrompt: null, customPromptEnabled: false });
    expect(
      legacyMirrorOf([
        { id: "a", text: "one", enabled: true },
        { id: "b", text: "two", enabled: false },
      ])
    ).toEqual({ customPrompt: "one", customPromptEnabled: true });
  });
});

describe("activePromptTexts", () => {
  it("returns enabled texts in order", () => {
    expect(
      activePromptTexts([
        { id: "a", text: "one", enabled: true },
        { id: "b", text: "two", enabled: false },
      ])
    ).toEqual(["one"]);
  });
});
