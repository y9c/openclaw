import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "../..");

type WorkflowJob = {
  needs?: string | string[];
  steps?: WorkflowStep[];
  with?: Record<string, unknown>;
};

type WorkflowStep = {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

function isWorkflowWithJobs(value: unknown): value is { jobs: Record<string, WorkflowJob> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "jobs" in value &&
    typeof value.jobs === "object" &&
    value.jobs !== null
  );
}

function needsList(job: WorkflowJob | undefined): string[] {
  if (!job?.needs) {
    return [];
  }
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

describe("openclaw npm release workflow", () => {
  it("builds Caddy SSRF binaries from the release tag's pinned version", () => {
    const workflowPath = path.join(repoRoot, ".github/workflows/openclaw-npm-release.yml");
    const workflow: unknown = YAML.parse(readFileSync(workflowPath, "utf8"));
    expect(isWorkflowWithJobs(workflow)).toBe(true);
    if (!isWorkflowWithJobs(workflow)) {
      throw new Error("workflow has no jobs map");
    }

    const jobs = workflow.jobs;
    const resolver = jobs["resolve_caddy_ssrf_version"];
    const resolverSteps = resolver?.steps ?? [];
    const checkoutStep = resolverSteps.find((step) => step.uses === "actions/checkout@v4");
    const versionStep = resolverSteps.find((step) => step.id === "caddy-version");

    expect(checkoutStep?.with?.["ref"]).toBe("${{ inputs.tag }}");
    expect(versionStep?.run).toContain("scripts/caddy-ssrf-version.txt");
    expect(versionStep?.run).toContain("version=");
    expect(versionStep?.run).toContain("Invalid Caddy SSRF version");
    expect(needsList(jobs["build_caddy_ssrf"])).toContain("resolve_caddy_ssrf_version");
    expect(jobs["build_caddy_ssrf"]?.with?.["version"]).toBe(
      "${{ needs.resolve_caddy_ssrf_version.outputs.version }}",
    );
    expect(needsList(jobs["publish_openclaw_npm"])).toContain("build_caddy_ssrf");
  });
});
