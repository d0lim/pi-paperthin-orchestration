# Package development

This repository develops an installable Pi package. The target of an installed workflow is the user's current project, not this package directory.

- `extensions/workflow.ts`: Pi commands, activation, role guards and delegation tools.
- `lib/runtime.mjs`: portable launch arguments and instruction/config loading.
- `instructions/` and `config/`: bundled workflow policies and role defaults.
- `vendor/paperthin/`: pinned upstream skills; preserve content, checksums and license.
- `examples/todo-cli/`: optional fixture app, independent of the extension.
- Run `npm test` for runtime, extension/package loading, and example checks.

Keep installed resources independent of this repository's developer instructions. Load project settings from the target `.pi/paperthin.json` and respect target repository instructions. Ordinary Pi sessions stay unchanged until `/lead` activation or an explicit role flag. Do not silently fall back to a different model/provider or API billing path.

Use installed Pi APIs and existing pi-herdr transport. Keep package resources separate from per-project task artifacts. Do not add Compound Engineering. Report mock tests separately from real model or Herdr integration tests. Remote changes follow the user's requested scope.
