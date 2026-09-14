# Package development

This repository develops an installable Pi package. An installed workflow targets the user's current project, not the package directory.

- `extensions/workflow.ts`: commands, activation, role guards, routing and job tools.
- `lib/runtime.mjs`: portable launch arguments and policy/config loading.
- `lib/jobs.mjs`: bounded headless processes, owned lifecycle and durable output.
- `config/`: role/routing defaults and the 28-skill invocation catalog.
- `instructions/`: common and role policies, independent of developer instructions.
- `vendor/paperthin/`: pinned upstream skills; preserve exact content, checksums and license.
- `docs/orchestration.md`: execution, routing, catalog and UI contract.
- `examples/todo-cli/`: optional fixture app, independent of installation.
- Run `npm test` for runtime, job, extension/package and example checks.

Ordinary Pi sessions remain inactive until `/lead` or an explicit role flag. Respect target project instructions and trusted `.pi/paperthin.json` overrides. Separate neutral modelchk advice from the executor's bounded per-job routing. Explicit user profile/effort pins win. Never silently fall back on authentication, availability or API billing failures. Fable headless execution must honor the configured consent policy because non-interactive requests may consume usage credits.

Lead owns the only scheduler and workflow loop. Children never re-delegate. Default jobs run without panes, with bounded concurrency, queue, timeout and owned cancellation. Keep process completion distinct from reviewed quality. Preserve outputs and task evidence, and report mock tests separately from real model, Herdr UI and full workflow checks.

Use installed Pi APIs. Retain pi-herdr only for explicit compatibility needs; do not claim its current-pane split API implements task tabs. Do not control existing Herdr panes from outside Herdr. Keep package resources separate from project artifacts. Respect upstream user-only invocation and maintenance applicability. Do not add Compound Engineering. Remote changes follow the user's authorized scope.
