---
name: tag-duplicate-prs-issues
description: Maintainer workflow for deciding whether an OpenClaw pull request or issue is a duplicate, gathering evidence with ghreplica and pr-search-cli, grouping related work in prtags, and drafting the GitHub comment or tagging rationale. Use when Codex needs to search for duplicate PRs or issues, pick a canonical item, create or reuse a duplicate group, enforce one-group-per-target discipline, or prepare the exact maintainer-facing close/comment output.
---

# Tag Duplicate PRs And Issues

Use this skill when a maintainer needs to decide whether a pull request or issue is a duplicate of existing work.

This skill is for maintainer triage and grouping.
It is not for reviewing the implementation quality of a PR.

## Required Setup

Do not start duplicate triage until this setup is complete.

### Install the companion skills

Install these skills first because they teach the agent how to use the two main CLIs correctly:

- `ghreplica` skill from `/Users/onur/offline/ghreplica/skills/ghreplica/SKILL.md`
- `prtags` skill from `/Users/onur/offline/prtags/skills/prtags/SKILL.md`

This skill assumes those two skills are available and can be used during the same run.

### Install the CLIs

Install `ghreplica` and `prtags` from their latest GitHub releases.
Do not rely on an old local build unless the maintainer explicitly wants to test unreleased behavior.

`ghreplica` CLI install path:

```bash
curl -fsSL https://raw.githubusercontent.com/dutifuldev/ghreplica/main/scripts/install-ghr.sh | bash
```

`prtags` CLI install path:

```bash
curl -fsSL https://raw.githubusercontent.com/dutifuldev/prtags/main/scripts/install-prtags.sh | bash
```

Use `pr-search-cli` with `uvx`.
Do not require a permanent install unless the maintainer explicitly wants one.

```bash
uvx pr-search-cli status
uvx pr-search-cli code similar 67144
```

### Authenticate prtags

`prtags` should be logged in with the maintainer's own GitHub account through OAuth device flow.
Do not use a shared maintainer token for interactive triage.

```bash
prtags auth login
prtags auth status
```

The expected outcome is that `prtags` stores the logged-in maintainer identity locally and uses that account for authenticated writes.

### Verify the tools before triage

Before using this skill, make sure all three tools are available:

```bash
ghr repo view openclaw/openclaw
prtags auth status
uvx pr-search-cli status
```

## Goal

For each target PR or issue:

1. gather duplicate evidence
2. decide whether it is a real duplicate
3. choose the canonical item when a duplicate cluster exists
4. create or reuse one `prtags` group for that duplicate cluster
5. save the maintainer judgment in `prtags`
6. draft the GitHub comment the maintainer can post

## Tool Roles

Use the tools with these boundaries:

- `ghreplica` is the raw evidence source
  - use it for title/body/comment search, related PRs, overlapping files, overlapping ranges, and current PR or issue status
- `pr-search` is candidate generation and ranking
  - use it to suggest likely duplicate PRs or issue-cluster context
  - do not treat it as final truth
- `prtags` is the maintainer curation layer
  - use it to create or reuse one duplicate group
  - use it to save the canonical item, confidence, and rationale

## Working Rules

- Do not call something a duplicate only because the titles are similar.
- Do not call something a duplicate only because the same files changed.
- A duplicate cluster should be based on the same user-facing problem, the same intent, and substantially overlapping implementation or investigation context.
- The canonical item is the one the maintainer wants future readers to follow.
- The canonical item does not need to be the oldest item.
- If a newer PR or issue is the clearer or more complete path, it can be canonical.

## One-Group Rule

Treat duplicate groups as exclusive.
A PR or issue should belong to at most one duplicate group at a time.

That means:

- before creating a new group, search for an existing group that already represents the same duplicate story
- if the target already appears to belong to a different duplicate group, stop and resolve that conflict first
- do not create a second group for the same target just because the wording is slightly different
- if two plausible existing groups overlap and you cannot safely merge the judgment, stop and ask the maintainer

This rule matters more than speed.
The skill should keep one coherent duplicate cluster per problem, not many near-duplicate clusters.

## What A Good Duplicate Group Represents

A duplicate group should describe the underlying problem and the intended fix direction.
Do not group items only because they share a keyword.

Good group shape:

- same user-facing bug or same maintainer-facing task
- same subsystem or code surface
- same intended change direction
- same likely canonical follow-up path

Bad group shape:

- “all PRs that touch Slack”
- “all issues mentioning retry”
- “all auth-related items”

The group title should name the real problem.
The group description should summarize the intent and the code surface.

Examples:

- `gateway: startup regression from channel status bootstrap`
- `whatsapp: QR preflight timeout handling`
- `release: cross-OS validation handoff gaps`

## Evidence Checklist

Before declaring a duplicate, gather evidence from at least two categories.

For PRs:

- same or nearly same problem statement
- same changed files or overlapping file ranges
- same fix direction
- same subsystem and failure mode
- same linked issue or same user-visible symptom

For issues:

- same user-visible problem
- same reproduction story or same failure mode
- same likely fix area
- same PRs already linked or discussed
- same maintainers already steering toward the same canonical thread

If you only have wording similarity, that is not enough.

## Step 1: Read The Target

Start by reading the target itself.

For a PR:

```bash
ghr pr view -R openclaw/openclaw <number> --comments
ghr pr reviews -R openclaw/openclaw <number>
ghr pr comments -R openclaw/openclaw <number>
```

For an issue:

```bash
ghr issue view -R openclaw/openclaw <number> --comments
ghr issue comments -R openclaw/openclaw <number>
```

Record:

- target type and number
- title
- problem statement
- proposed intent
- subsystem
- whether it is open, closed, or merged
- whether there is already a likely canonical item mentioned by humans

## Step 2: Search Broadly With ghreplica

Use `ghreplica` first because it is the most direct evidence source.

### PR duplicate search

Run all of these when the target is a PR:

```bash
ghr search related-prs -R openclaw/openclaw <pr-number> --mode path_overlap --state all
ghr search related-prs -R openclaw/openclaw <pr-number> --mode range_overlap --state all
ghr search mentions -R openclaw/openclaw --query "<key phrase from title or body>" --mode fts --scope pull_requests --state all
ghr search mentions -R openclaw/openclaw --query "<subsystem or error phrase>" --mode fts --scope issues --state all
```

Use `prs-by-paths` or `prs-by-ranges` when the likely duplicate surface is already known:

```bash
ghr search prs-by-paths -R openclaw/openclaw --path src/example.ts --state all
ghr search prs-by-ranges -R openclaw/openclaw --path src/example.ts --start 20 --end 80 --state all
```

### Issue duplicate search

`ghreplica` does not have a special issue-to-issue “related issues” command.
For issues, search mirrored text and linked PR context instead.

Run targeted text searches:

```bash
ghr search mentions -R openclaw/openclaw --query "<issue title phrase>" --mode fts --scope issues --state all
ghr search mentions -R openclaw/openclaw --query "<error message or symptom>" --mode fts --scope issues --state all
ghr search mentions -R openclaw/openclaw --query "<subsystem phrase>" --mode fts --scope pull_requests --state all
```

Then inspect the candidate PRs or issues those searches uncover.

## Step 3: Use pr-search As A Hint Layer

Use `pr-search` after `ghreplica`.
It is good at surfacing candidates quickly, but it is not the final decision-maker.

For a PR:

```bash
pr-search -R openclaw/openclaw code similar <pr-number>
pr-search -R openclaw/openclaw code clusters for-pr <pr-number>
pr-search -R openclaw/openclaw issues for-pr <pr-number>
pr-search -R openclaw/openclaw issues duplicate-prs
```

Interpretation:

- `code similar` suggests PRs with similar change shape
- `code clusters for-pr` shows the PR’s nearby code cluster
- `issues for-pr` shows which issue clusters the PR appears to belong to
- `issues duplicate-prs` is useful for spotting already-known duplicate PR patterns

For an issue:

- use `ghreplica` first to find candidate PRs or issue wording
- if the issue has linked PRs or a likely implementation PR, run `pr-search` on those PRs
- treat issue-cluster output as supporting context, not as enough by itself to call the issue a duplicate

## Step 4: Decide The Outcome

Choose one of these outcomes:

- `not_duplicate`
- `duplicate_needs_judgment`
- `duplicate_confirmed`

Use `duplicate_confirmed` only when the evidence is strong enough that the maintainer could safely close or retag the non-canonical item.

Use `duplicate_needs_judgment` when:

- the problem looks the same but the implementation goal differs
- the code overlap is weak
- the issue wording is ambiguous
- there may be two valid canonical paths
- the target appears to intersect two existing duplicate groups

## Step 5: Reuse Or Create One prtags Group

Before creating a group, search `prtags` for an existing one.

Start with text search over groups:

```bash
prtags search text -R openclaw/openclaw "<problem phrase>" --types group --limit 10
prtags search similar -R openclaw/openclaw "<problem summary>" --types group --limit 10
prtags group list -R openclaw/openclaw
```

Inspect likely groups:

```bash
prtags group get <group-id>
prtags group get <group-id> --include-metadata
```

Reuse an existing group when:

- it represents the same problem
- it already contains the canonical item or clearly related members
- adding the target would keep the group coherent

Create a new group only when no existing group clearly fits.

Create the group with a problem-based title and an intent-based description:

```bash
prtags group create -R openclaw/openclaw \
  --kind mixed \
  --title "<problem-centered title>" \
  --description "<same intent, subsystem, and likely canonical path>" \
  --status open
```

Then attach the target and any known duplicate members:

```bash
prtags group add-pr <group-id> <pr-number>
prtags group add-issue <group-id> <issue-number>
```

If a target appears to already belong to another duplicate group and you cannot safely reuse that group, stop.
Do not create a second group.

## Step 6: Ensure The Annotation Fields Exist

Use `field ensure` so the skill is idempotent.

Recommended target-level fields:

```bash
prtags field ensure -R openclaw/openclaw --name duplicate_status --scope pull_request --type enum --enum-values not_duplicate,candidate,confirmed --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_status --scope issue --type enum --enum-values not_duplicate,candidate,confirmed --filterable
prtags field ensure -R openclaw/openclaw --name canonical_item --scope pull_request --type text --searchable
prtags field ensure -R openclaw/openclaw --name canonical_item --scope issue --type text --searchable
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope pull_request --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope issue --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope pull_request --type text --searchable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope issue --type text --searchable
```

Recommended group-level fields:

```bash
prtags field ensure -R openclaw/openclaw --name canonical_item --scope group --type text --searchable
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope group --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope group --type text --searchable
prtags field ensure -R openclaw/openclaw --name cluster_summary --scope group --type text --searchable
```

## Step 7: Save The Maintainer Judgment In prtags

For a PR:

```bash
prtags annotation pr set -R openclaw/openclaw <pr-number> \
  duplicate_status=confirmed \
  canonical_item="pr:<canonical-number>" \
  duplicate_confidence=high \
  duplicate_rationale="<same problem, same fix direction, overlapping files and comments>"
```

For an issue:

```bash
prtags annotation issue set -R openclaw/openclaw <issue-number> \
  duplicate_status=confirmed \
  canonical_item="issue:<canonical-number>" \
  duplicate_confidence=high \
  duplicate_rationale="<same user-visible problem and same intended fix path>"
```

For the group:

```bash
prtags annotation group set <group-id> \
  canonical_item="pr:<canonical-number>" \
  duplicate_confidence=high \
  cluster_summary="<one-sentence problem summary>" \
  duplicate_rationale="<why these items belong in one duplicate cluster>"
```

When the evidence is incomplete, set `duplicate_status=candidate` and lower the confidence.

## Step 8: Draft The GitHub Comment

Do not post the comment automatically unless the maintainer explicitly asked for that.
Draft the exact text.

The comment should:

- name the canonical item
- explain why this was grouped as a duplicate
- mention the shared problem and fix direction
- mention any important difference if it exists
- be short and decisive

Example for a PR:

```text
Closing this as a duplicate of #<canonical>.

These two PRs are solving the same problem in the same subsystem, and the implementation surface overlaps enough that we want one canonical thread for follow-up and review.

I grouped this work in PRtags under the same duplicate cluster so future triage stays attached to one path.
```

Example for an issue:

```text
Closing this as a duplicate of #<canonical>.

This report describes the same underlying problem and the same likely fix path, so we want future investigation and updates to stay on one canonical issue.

I grouped the related reports in PRtags so the duplicate trail stays visible.
```

If the item is only a likely duplicate, do not draft a close comment.
Draft a softer maintainer note instead.

## Output Format

Return a short maintainer report with these sections:

```text
Decision: duplicate_confirmed | duplicate_needs_judgment | not_duplicate
Target: PR #<n> | Issue #<n>
Canonical item: PR #<n> | Issue #<n> | none
Confidence: high | medium | low

Evidence:
- ...
- ...
- ...

prtags actions:
- reused group <group-id> | created group <group-id>
- added members: ...
- annotations written: ...

Suggested GitHub comment:
...
```

## Stop Conditions

Stop and escalate instead of forcing a duplicate decision when:

- the target appears to belong to two different duplicate groups
- the likely canonical item is unclear
- the wording matches but the implementation goals differ
- two PRs touch the same files for different reasons
- two issues describe similar symptoms but likely different root causes

The maintainer should get one clean duplicate judgment or an explicit “needs judgment” result.
Do not blur the line.
