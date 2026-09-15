# Package development

This repository develops an installable Pi package. An installed workflow targets the user's current project, not the package directory.

- `extensions/workflow.ts`: activation, role guards, Pi commands and tools.
- `lib/runtime.mjs`: portable launch arguments and policy/config loading.
- `lib/routing.mjs`: phase profiles, explicit pins, billing policy and structured runtime/review interpretation.
- `lib/controller.mjs`: bind a workflow attempt to an owned job and collect its actual result.
- `lib/jobs.mjs`: bounded headless processes, owned lifecycle and durable output.
- `lib/workflow-state.mjs`: durable plan/candidate approvals, worktrees, file ownership, dependencies, checks, recovery and integration.
- `lib/herdr.mjs`: explicit new interactive task tabs from inside Herdr.
- `lib/metrics.mjs`: reported session usage, timing and unknown-value accounting.
- `config/`: role/routing defaults and the 28-skill invocation catalog.
- `instructions/`: common and role policies, independent of developer instructions.
- `vendor/paperthin/`: pinned upstream skills; preserve exact content, checksums and license.
- `docs/orchestration.md`: execution, routing, catalog and UI contract.
- `examples/todo-cli/`: optional fixture app, independent of installation.
- Run `npm test` for runtime, workflow, job, extension/package and example checks. Supply `PI_PACKAGE_DIR` when using an isolated Pi SDK so loader checks run instead of skipping.

Ordinary Pi sessions remain inactive until `/lead` or an explicit role flag. Respect target project instructions and trusted `.pi/paperthin.json` overrides. Separate neutral modelchk advice from the executor's bounded per-job routing. Explicit user profile/effort pins win. Default phases are Fable plan review, Codex/Sol implementation and Opus task/final integration review. Never silently fall back on authentication, availability or API billing failures. Fable headless execution must honor the configured consent policy because non-interactive requests may consume usage credits; naming Fable does not authorize changing that policy.

Lead owns the only scheduler and workflow loop. Children never re-delegate. Default jobs run without panes, with bounded concurrency, queue, timeout and owned cancellation. Implementation and approval review must bind to a managed run and phase. Keep process completion distinct from reviewed quality. Reviews require the actual job, verified reported model and schema-valid verdict for the exact plan/base/candidate; role prose templates must not conflict with final JSON. Preserve outputs and task evidence, and report mock tests separately from real model, Herdr UI and full workflow checks.

Use registered worktrees and explicit file ownership. Lead commits owned paths and freezes the candidate before executing recorded checks and code review. Integration uses a separate worktree; completion requires checks and final integration review for that candidate. Do not move the user's original branch or delete worktrees as an implicit side effect. Keep the durable ledger shared through the Git common directory with one controller owner. Recovery records inspected state and must not silently restart, reset or take over another controller's work. Changes to an approved target require fresh matching evidence.

Use installed Pi APIs. Retain pi-herdr only for explicit compatibility needs; do not claim its current-pane split API implements task tabs. The native task-tab adapter must require an explicit workspace and create a separate session inside Herdr. It does not resume a headless job or register its output as approval. Do not control existing Herdr panes from outside Herdr. Preserve uncertain startup state instead of blindly repeating prompts or destroying a created tab. Keep package resources separate from project artifacts. Respect upstream user-only invocation and maintenance applicability. Do not add Compound Engineering. Remote changes follow the user's authorized scope.
