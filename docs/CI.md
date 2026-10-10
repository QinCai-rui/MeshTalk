# Pull request checks

`.github/workflows/pr-checks.yml` runs on every pull request, including forks. It has read-only repository access and uses no deployment secrets.

## Coverage

`.github/scripts/affected-packages.ts` selects jobs from changed paths. Shared TypeScript changes also select their dependent clients. Root Bun manifest or lockfile changes select all TypeScript jobs and native desktop tests. Changes to this workflow or its scripts select every job. Manual runs also select every job.

| Package | Checks |
| --- | --- |
| TUI, CLI, control | Typecheck, build, and unit tests |
| Desktop frontend | Typecheck, build, unit tests, and Chromium Playwright tests against demo data |
| Common | Unit tests; dependent clients cover shared types |
| Launcher | Bundle local imports with third-party packages left external |
| Backend | Locked Python 3.12 environment and serial pytest tests with temporary application state |
| Native desktop | Linux Rust compilation and tests, generated icons, and the development sidecar override |
| Website | Existing npm lockfile installation, build, and Bun tests |
| Analytics | Python parsing without service initialization, and Worker JavaScript bundling |

Native jobs run for changes under `desktop/src-tauri/`, `desktop/scripts/`, the desktop icon, or the desktop manifest. Frontend-only desktop changes do not select native tests. Native jobs do not package, sign, or publish the app.

Browser failures retain Playwright traces and upload test output for seven days. These tests do not prove macOS WebView behavior. Analytics checks do not exercise its database or deployed Worker. No job deploys to production.

## Final check

The final `CI` check requires every selected job to succeed. It fails if detection fails or a selected job fails, is cancelled, or is skipped. Documentation-only changes pass after the selection tests, without package builds.

This workflow does not change repository rules or branch protection. `CI` is the stable check name available for a required-check rule. Existing review, release, and deployment workflows remain unchanged.
