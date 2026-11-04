# GitHub Actions configuration

Start with the workflows in `.github/workflows/`. All 15 use Ork repository paths and GitHub-hosted runners, with optional services disabled until you configure them.

## Available with GitHub only

| Workflow | Behavior |
| --- | --- |
| `ci.yml` | Type checks, unit tests, PostgreSQL journeys, Docker checks, and reusable workflows. Pushes to main can publish server images. Manual runs use the scope below. |
| `playwright.yml` | Browser tests and screenshots, with reports retained as Actions artifacts. |
| `nightly-verification.yml` | Scheduled browser and edge-case checks, with native GitHub artifacts. |
| `topology-verification.yml` | Manual Docker topology verification. |
| `computer-replay.yml` | Manual browser/computer replay without model inference. |
| `publish-server-image.yml` | Native amd64 and arm64 images in this repository's GHCR namespace, using `GITHUB_TOKEN`. |
| `publish-playwright-report.yml` | PR links to the matching Actions report and artifact. S3 galleries are optional. |
| `desktop-macos-screenshot.yml` | Diagnostic macOS screenshots. |
| `mobile-android-screenshots.yml` | Diagnostic Android screenshots and artifacts. S3 publication is explicit. |
| `release-desktop.yml` | Unsigned diagnostic installers as Actions artifacts by default. Signed stable releases require separate configuration. |
| `release-android-apk.yml` | A development-signed diagnostic APK on a GitHub runner by default. EAS production publication is explicit. |
| `release-mobile.yml` | Android diagnostic build by default. iOS submission is an explicit option requiring Expo and Apple accounts. |
| `model-catalog-bump.yml` | Update the model catalog and verify it. PR creation requires the repository/organization bot policy below or a dedicated PAT. |
| `weekly-dependencies.yml` | Check updater configuration. AI dependency updates require the dedicated credentials below. |
| `review-bot.yml` | Route review fallback events after the selected review applications have been installed. |

Manual CI runs static/type checks and safety checks, three unit-test shards, and two PostgreSQL test shards. PR-only build, native, and Web E2E jobs are skipped, along with push-only image publishing, OTA, and deployment.

Diagnostic runs upload unsigned installers or development-signed APKs to Actions artifacts. Stable feeds and store submissions use the release modes described below.

## GitHub repository settings

Keep Actions enabled and allow the pinned actions used by the workflows. Keep default workflow permissions read-only. Publishing jobs request their own permissions.

For automated dependency PRs, enable **Allow GitHub Actions to create and approve pull requests** at the organization and repository levels. The workflows create reviewable PRs and do not automatically approve or merge them. If organization policy prevents that setting, supply a dedicated `GH_DEPENDENCY_UPDATES_PAT` with repository contents and pull-request write access. The AI updater also needs that PAT to update its own subscription-auth secret.

When the model-catalog updater uses `GITHUB_TOKEN`, GitHub creates its PR workflow runs in an approval-required state. A maintainer with write access can start them by selecting **Approve workflows to run**. A dedicated PAT allows the PR checks to start automatically. See [GitHub's workflow-triggering rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow). Review every automated dependency patch before merging it.

The review fallback labels are `review:cr` and `review:greptile`. Install the Qodo, CodeRabbit, and Greptile GitHub applications and grant access to this repository to use the corresponding external reviewers. GitHub Actions does not provide those services by itself.

GHCR publication needs permission for the repository workflow to create and write packages in its organization. If organization package policy denies that, an organization owner must allow it. No manually stored registry token is required for the normal GHCR path.

After the first GHCR publication, set the `app`, `updater`, and `computer` packages to **Public** in their GitHub package settings so installers can pull them anonymously. New container packages default to private, and inheriting repository access does not change their visibility. See [Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) and [package visibility settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

## Expo and mobile production releases

Create an Expo account and an EAS project owned by the Ork operator. Set these repository entries:

| Type | Name | Purpose |
| --- | --- | --- |
| Secret | `EXPO_TOKEN` | EAS automation token for the Ork project. |
| Variable | `EXPO_PROJECT_ID` | Ork EAS project UUID. |
| Variable | `EXPO_OWNER` | Expo account or organization that owns the project. |
| Variable | `EXPO_PUBLIC_API_URL` | Reachable production HTTPS API origin. |
| Variable | `MOBILE_OTA_ENABLED` | Set to `true` only after compatible Ork native builds exist. |

The workflows bind this project configuration in a disposable runner checkout. The tracked app configuration stays detached from external projects. Configure the production environment and managed signing credentials in EAS.

For optional OTA source-map uploads, configure the repository secrets `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`. `SENTRY_URL` is optional. A configured token requires both the organization and project names.

Android push notifications require a Firebase project with the `run.orkbot.app` application and a `GOOGLE_SERVICES_JSON` file variable in the EAS production environment. Builds without Firebase remain supported. The EAS mode of the APK workflow publishes to GitHub Releases. For Google Play, prepare a Play Console account and a separate submission process.

For iOS, create an Apple Developer account, an App Store Connect app, signing credentials, and review metadata. Configure these secrets:

- `ASC_APP_ID`
- `ASC_KEY_ID`
- `ASC_ISSUER_ID`
- `ASC_PRIVATE_KEY`

Choose the iOS submission input explicitly. Missing Expo or Apple configuration stops that request with the missing entry names. It does not turn a diagnostic build into a store release.

## Signed desktop releases and updates

For a manual signed release, select a `vMAJOR.MINOR.PATCH` tag and set `signed_release=true`. The tag must match the desktop version and changelog and pass the ancestry check against `main`. For signed releases triggered by a tag push, set `DESKTOP_SIGNED_RELEASE_ENABLED=true` after configuring every requested platform.

macOS needs an Apple Developer **Developer ID Application** certificate and an App Store Connect API key for notarization:

- Secrets: `DESKTOP_MAC_CSC_LINK`, `DESKTOP_MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`.
- Optional secret: `DESKTOP_MAC_PROVISIONING_PROFILE` for the associated passkey capability.

Windows signed releases use an Azure Artifact Signing account and certificate profile with an OIDC trust for the `desktop-release` GitHub environment:

- Secrets: `DESKTOP_WIN_AZURE_CLIENT_ID`, `DESKTOP_WIN_AZURE_TENANT_ID`.
- Variables: `DESKTOP_WIN_SIGNING_ENDPOINT`, `DESKTOP_WIN_SIGNING_ACCOUNT`, `DESKTOP_WIN_SIGNING_PROFILE`, `DESKTOP_WIN_PUBLISHER`.

Linux update verification needs an Ed25519 key pair that the Ork operator generates and owns:

- Secret: `DESKTOP_LINUX_UPDATE_SIGNING_KEY`, the private signing key.
- Variable: `ORKBOT_LINUX_UPDATE_PUBLIC_KEY`, its matching public PEM key.

Desktop updates remain disabled unless `ORKBOT_ENABLE_AUTO_UPDATE=1` is set for a configured release. Linux also requires the matching public verification key at build time. Keep the private key outside the repository.

## Optional hosted report galleries

GitHub artifacts work without an object-storage account. To publish the persistent screenshot/report gallery, configure an S3-compatible bucket and its public HTTPS report origin:

- Secrets: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- Variables: `S3_BUCKET`, `S3_ENDPOINT`, `PLAYWRIGHT_PUBLIC_BASE_URL`.
- Optional variable: `S3_REGION`, default `us-east-1`.

Partial storage configuration does not publish a gallery. The GitHub artifact remains the default report. The Android screenshot workflow requires the gallery input explicitly before using storage credentials.

## AI dependency updates

The original agent-assisted updater requires a Codex-compatible subscription login and a dedicated GitHub PAT. It runs dependency code without repository-write credentials and publishes through a separate job.

- Secret: `CODEX_SUBSCRIPTION_AUTH`, the dedicated updater's validated subscription-auth JSON.
- Secret: `GH_DEPENDENCY_UPDATES_PAT`, with repository contents/pull-request write access and repository-secret write access to persist a rotated subscription login.

Use a dedicated automation identity and token. Do not copy a personal login into GitHub automatically. Scheduled runs skip an unconfigured updater. A manual request without both credentials fails and names the missing entries in its log.

The separate model-catalog updater uses GitHub alone, subject to the automated-PR policy above.

## Production deployment

Deployment stays off until the operator has a server and explicitly sets `PRODUCTION_DEPLOY_ENABLED=true`. Prepare Docker, persistent storage, backups, HTTPS/DNS, and the restricted `deploy-main` host command described in the deployment guides.

- Secrets: `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`, `PRODUCTION_SSH_PRIVATE_KEY`, `PRODUCTION_SSH_KNOWN_HOSTS`.
- Variables: `TAILSCALE_CLIENT_ID`, `TAILSCALE_AUDIENCE`, plus an Ork-owned Tailscale federated identity configuration.

Keep runtime model credentials and application secrets on the server or in the configured secret store. They are separate from CI credentials. Enabling a workflow does not configure a production server or DNS.

Depot is optional. The image publisher uses GitHub-hosted runners when `DEPOT_PROJECT_ID` is absent, and falls back to them after a failed Depot attempt.

## Configure credentials

Enter repository values in **Settings > Secrets and variables > Actions**. Configure each service in its own console. Enter secret values there or through `gh secret set` using a private file or standard input. Never put credentials in source, commit messages, logs, or chat.
