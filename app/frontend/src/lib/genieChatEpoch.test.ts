import { describe, expect, it } from "vitest";
import { bumpGenieChatEpoch, isCurrentGenieChatEpoch } from "./genieChatEpoch";

describe("genieChatEpoch", () => {
  it("treats a reply as current when the epoch was not bumped", () => {
    const sendEpoch = 3;
    expect(isCurrentGenieChatEpoch(sendEpoch, 3)).toBe(true);
  });

  it("treats a reply as stale after New chat bumps the epoch", () => {
    const sendEpoch = 3;
    const afterNewChat = bumpGenieChatEpoch(sendEpoch);
    expect(afterNewChat).toBe(4);
    expect(isCurrentGenieChatEpoch(sendEpoch, afterNewChat)).toBe(false);
  });

  it("discards a late answer so the new chat is not re-attached to the old conversation", async () => {
    let epoch = 0;
    let conversationId: string | null = null;
    let turns: string[] = [];

    // User asks a question (send captures the current epoch).
    const sendEpoch = epoch;
    conversationId = null;
    turns = ["What is cash?"];
    const pending = Promise.resolve({ conversation_id: "conv-old", text: "Cash is $12M." });

    // User clicks New chat before the answer arrives.
    epoch = bumpGenieChatEpoch(epoch);
    conversationId = null;
    turns = [];

    const ans = await pending;
    if (isCurrentGenieChatEpoch(sendEpoch, epoch)) {
      conversationId = ans.conversation_id;
      turns.push(ans.text);
    }

    expect(conversationId).toBeNull();
    expect(turns).toEqual([]);

    // The next question starts a fresh conversation instead of following up.
    expect(conversationId).toBeNull();
  });
});
