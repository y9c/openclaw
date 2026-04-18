import { describe, expect, it } from "vitest";
import { resolveWhatsAppSessionConversation } from "./session-conversation.js";

describe("resolveWhatsAppSessionConversation", () => {
  it("treats scoped group account suffixes as group-local routing state, not threads", () => {
    expect(
      resolveWhatsAppSessionConversation({
        kind: "group",
        rawId: "120363407398133622@g.us:thread:whatsapp-account-work",
      }),
    ).toEqual({
      id: "120363407398133622@g.us",
      baseConversationId: "120363407398133622@g.us",
      parentConversationCandidates: ["120363407398133622@g.us"],
    });
  });

  it("ignores non-group or unrelated session ids", () => {
    expect(
      resolveWhatsAppSessionConversation({
        kind: "channel",
        rawId: "120363407398133622@g.us:thread:whatsapp-account-work",
      }),
    ).toBeNull();
    expect(
      resolveWhatsAppSessionConversation({
        kind: "group",
        rawId: "120363407398133622@g.us:thread:77",
      }),
    ).toBeNull();
  });
});
