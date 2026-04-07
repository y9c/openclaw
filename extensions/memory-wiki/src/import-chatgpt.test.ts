import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatGptExportFile } from "./import-chatgpt.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir } = createMemoryWikiTestHarness();

describe("parseChatGptExportFile", () => {
  it("parses conversation arrays into transcript artifacts", async () => {
    const dir = await createTempDir("memory-wiki-chatgpt-export-");
    const exportPath = path.join(dir, "chatgpt-export.json");
    await fs.writeFile(
      exportPath,
      JSON.stringify([
        {
          id: "conv-alpha",
          title: "Alpha thread",
          create_time: 1_710_000_000,
          update_time: 1_710_000_100,
          mapping: {
            "2": {
              message: {
                author: { role: "assistant" },
                create_time: 1_710_000_020,
                content: { parts: ["hi there"] },
              },
            },
            "1": {
              message: {
                author: { role: "user" },
                create_time: 1_710_000_010,
                content: { parts: ["hello alpha"] },
              },
            },
          },
        },
      ]),
      "utf8",
    );

    const conversations = await parseChatGptExportFile(exportPath);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      conversationId: "conv-alpha",
      title: "Alpha thread",
      relativePath: expect.stringMatching(/^alpha-thread-/),
      messageCount: 2,
      participantRoles: ["assistant", "user"],
    });
    expect(conversations[0]?.transcriptBody).toContain("### User");
    expect(conversations[0]?.transcriptBody).toContain("hello alpha");
    expect(conversations[0]?.transcriptBody).toContain("### Assistant");
    expect(conversations[0]?.transcriptBody).toContain("hi there");
  });

  it("parses conversations envelopes", async () => {
    const dir = await createTempDir("memory-wiki-chatgpt-envelope-");
    const exportPath = path.join(dir, "export.json");
    await fs.writeFile(
      exportPath,
      JSON.stringify({
        conversations: [
          {
            conversation_id: "conv-envelope",
            title: "Envelope thread",
            mapping: {
              root: {
                message: {
                  author: { role: "user" },
                  content: { parts: ["hello from envelope"] },
                },
              },
            },
          },
        ],
      }),
      "utf8",
    );

    const conversations = await parseChatGptExportFile(exportPath);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      conversationId: "conv-envelope",
      title: "Envelope thread",
      messageCount: 1,
    });
  });
});
