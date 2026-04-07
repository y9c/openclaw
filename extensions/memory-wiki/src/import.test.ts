import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importMemoryWikiInput } from "./import.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

describe("memory-wiki import", () => {
  it("imports a single local file through the unified import runner", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const sourceRoot = await createTempDir("memory-wiki-import-file-");
    const sourcePath = path.join(sourceRoot, "alpha-notes.md");
    await fs.writeFile(
      sourcePath,
      `# Alpha Notes

alpha body
`,
      "utf8",
    );

    const result = await importMemoryWikiInput({
      config,
      inputPath: sourcePath,
    });

    expect(result.profileId).toBe("local-file");
    expect(result.importedCount).toBe(1);
    await expect(fs.readFile(path.join(rootDir, result.pagePaths[0]), "utf8")).resolves.toContain(
      "sourceType: local-file",
    );
    await expect(fs.readFile(path.join(rootDir, result.reportPath), "utf8")).resolves.toContain(
      "Profile: `local-file` (automatic)",
    );
    expect(result.taskId).toBeTruthy();
    expect(result.runId).toBeTruthy();
  });

  it("auto-detects markdown vaults and skips vault metadata directories", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const vaultPath = await createTempDir("memory-wiki-import-vault-");
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "projects"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, "alpha.md"),
      `---
tags:
  - alpha
aliases:
  - Alpha Note
---

# Alpha

alpha body with [[Beta Project|Beta]] and [Plan](projects/beta.md).
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultPath, "projects", "beta.md"),
      "# Beta\n\nbeta body\n",
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, ".obsidian", "workspace.json"), "{}", "utf8");

    const result = await importMemoryWikiInput({
      config,
      inputPath: vaultPath,
    });

    expect(result.profileId).toBe("markdown-vault");
    expect(result.artifactCount).toBe(2);
    expect(result.importedCount).toBe(2);
    const importedPage = await fs.readFile(path.join(rootDir, result.pagePaths[0]), "utf8");
    const parsedImportedPage = parseWikiMarkdown(importedPage);
    expect(parsedImportedPage.frontmatter).toMatchObject({
      sourceType: "markdown-vault",
      importRelativePath: "alpha.md",
      importedTags: ["alpha"],
      importedAliases: ["Alpha Note"],
      importedLinkTargets: ["Beta Project", "projects/beta.md"],
    });
    expect(parsedImportedPage.body).toContain("alpha body with Beta and Plan (projects/beta.md).");
    expect(parsedImportedPage.body).not.toContain("[[Beta Project|Beta]]");
    const sourceEntries = await fs.readdir(path.join(rootDir, "sources"));
    expect(
      sourceEntries.filter((entry) => entry.endsWith(".md") && entry !== "index.md"),
    ).toHaveLength(2);
    await expect(fs.readFile(path.join(rootDir, result.reportPath), "utf8")).resolves.toContain(
      "Profile: `markdown-vault` (automatic)",
    );
  });

  it("auto-detects logseq vaults and skips logseq metadata directories", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const vaultPath = await createTempDir("memory-wiki-import-logseq-");
    await fs.mkdir(path.join(vaultPath, "logseq"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "alpha.md"), "# Alpha\n\nlogseq vault body\n", "utf8");
    await fs.writeFile(
      path.join(vaultPath, "logseq", "settings.md"),
      "# Settings\n\nskip me\n",
      "utf8",
    );

    const result = await importMemoryWikiInput({
      config,
      inputPath: vaultPath,
    });

    expect(result.profileId).toBe("markdown-vault");
    expect(result.artifactCount).toBe(1);
    expect(result.importedCount).toBe(1);
    await expect(fs.readFile(path.join(rootDir, result.pagePaths[0]), "utf8")).resolves.toContain(
      "logseq vault body",
    );
  });

  it("imports chatgpt-export files explicitly as conversation sources", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const sourceRoot = await createTempDir("memory-wiki-import-placeholder-");
    const sourcePath = path.join(sourceRoot, "chatgpt-export.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify([
        {
          id: "conv-alpha",
          title: "Alpha thread",
          create_time: 1_710_000_000,
          update_time: 1_710_000_100,
          mapping: {
            root: {
              message: {
                author: { role: "user" },
                content: { parts: ["hello alpha"] },
              },
            },
            branch: {
              message: {
                author: { role: "assistant" },
                content: { parts: ["hi there"] },
              },
            },
          },
        },
      ]),
      "utf8",
    );

    const result = await importMemoryWikiInput({
      config,
      inputPath: sourcePath,
      profileId: "chatgpt-export",
    });

    expect(result.profileId).toBe("chatgpt-export");
    expect(result.importedCount).toBe(1);
    const importedPage = await fs.readFile(path.join(rootDir, result.pagePaths[0]), "utf8");
    const parsedImportedPage = parseWikiMarkdown(importedPage);
    expect(parsedImportedPage.frontmatter).toMatchObject({
      sourceType: "chatgpt-export",
      importProfile: "chatgpt-export",
      importedTags: ["chatgpt-export"],
      importedAliases: ["conv-alpha"],
    });
    expect(parsedImportedPage.body).toContain("## Conversation Transcript");
    expect(parsedImportedPage.body).toContain("### User");
    expect(parsedImportedPage.body).toContain("hello alpha");
    expect(parsedImportedPage.body).toContain("### Assistant");
    expect(parsedImportedPage.body).toContain("hi there");
  });

  it("auto-detects likely ChatGPT export files into the chatgpt-export importer", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const sourceRoot = await createTempDir("memory-wiki-import-chatgpt-auto-");
    const sourcePath = path.join(sourceRoot, "export.json");
    await fs.writeFile(
      sourcePath,
      JSON.stringify([
        {
          title: "Alpha thread",
          mapping: {
            root: {
              message: {
                author: { role: "user" },
                content: { parts: ["hello"] },
              },
            },
          },
        },
      ]),
      "utf8",
    );

    const result = await importMemoryWikiInput({
      config,
      inputPath: sourcePath,
    });

    expect(result.profileId).toBe("chatgpt-export");
    expect(result.importedCount).toBe(1);
    await expect(fs.readFile(path.join(rootDir, result.reportPath), "utf8")).resolves.toContain(
      "Profile: `chatgpt-export` (automatic)",
    );
  });

  it("writes duplicate and low-signal review sections for vault imports", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const vaultPath = await createTempDir("memory-wiki-import-review-");
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, "alpha.md"),
      `---
aliases:
  - Shared Alias
---

# Shared Title

This imported note has enough substance to avoid the low-signal bucket.
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultPath, "beta.md"),
      `---
aliases:
  - Shared Alias
---

# Shared Title

Another imported note with enough text to trigger duplicate clustering.
`,
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, "tiny.md"), "# Tiny\n\nok\n", "utf8");

    const result = await importMemoryWikiInput({
      config,
      inputPath: vaultPath,
    });

    const report = await fs.readFile(path.join(rootDir, result.reportPath), "utf8");
    expect(report).toContain("## Duplicate Title/Alias Clusters");
    expect(report).toContain("`Shared Title` (2 notes)");
    expect(report).toContain("## Low-Signal Sources");
    expect(report).toContain("`tiny.md` (Tiny):");
  });
});
