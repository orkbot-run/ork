<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Licensing rollout

This checkout contains a prospective license transition and draft agreements.
It does not establish legal approval, activate a GitHub integration, or deploy
the website. Do not publish the transition or accept CLA signatures until the
steps below are complete.

## Legal review and ownership

Counsel must approve [LICENSE.md](../LICENSE.md), [NOTICE](../NOTICE), the
[FAQ](licensing-faq.md), the website copy, the [commercial agreement](commercial-license.md),
and [CLA v1](cla/v1.md). Identify the actual legal licensor and its notice address
in the agreements. Replace template fields privately as appropriate, without
putting personal or customer information in the public repository.

Confirm the chain of rights for each new Ork contribution intended for commercial
licensing. Prior Apache grants remain valid. The frozen Apache baseline is
`7efb3c5e202ddb4a4da3cd07904cba7da4613d18`. The original import is
`dbbc5fc7f35f548ef0477b0ac0fedb586788fb5a`. This implementation keeps the existing
baseline on Apache and applies PolyForm to new original work. It does not attempt
to classify old automated renames as newly owned copyright.

Confirm the decision that internal work for a for-profit business requires a
commercial agreement for PolyForm-covered work unless PolyForm expressly
permits the use or applicable law allows it. Do not advertise a general free
business-use exception. Preserve PolyForm's actual permissions for noncommercial
purposes and its listed noncommercial organizations regardless of their funding.

The proposed commercial model is a monthly subscription per named user, shared
across that person's web, desktop, and mobile clients on deployments covered by
the order. Bots are not seats. Counsel must review billing, cancellation, seat
changes, customer hosting, and the scope of separately negotiated distribution
rights. Agree the per-seat price and licensor privately before offering sales.
The current draft is not a checkout, payment integration, or license activation
service. Do not advertise subscriptions as available until those steps are done.

## Activate the contributor agreement

Use the [hosted CLA Assistant](https://github.com/cla-assistant/cla-assistant)
or another reviewed signing service. A DCO alone does not supply the commercial
relicensing permission proposed in this CLA. Do not add a public signature ledger
containing account or personal metadata to this repository.

After counsel approves the licensor, agreement, and privacy process:

1. Remove the draft status from the approved agreement and publish that exact
   version as the CLA document in a GitHub Gist, as required by hosted CLA Assistant.
   Retain an immutable archive and content hash with the legal records.
2. Authorize the service for this repository and link the approved Gist. Review
   its requested permissions and signature storage and retention before enabling it.
3. Test a real PR from a contributor without a signature. Confirm its CLA status
   fails, the displayed document is the approved version, signing changes the
   status to passing, and a new contributor on the PR requires another signature.
4. Require the actual status context emitted by the service in the branch rules.
   Verify a missing status blocks merge. Do not infer this from a passing workflow.
5. Test agreement-version changes and the service's re-signing behavior before
   accepting a revised agreement. Keep each accepted version available.

The similarly named `contributor-assistant/github-action` was archived by its
maintainer in March 2026. This transition does not introduce that unmaintained
action or treat its presence as a working CLA integration. GitHub administration
and the signing flow must be verified on the hosted service.

## Check source and dependency notices

Run:

```bash
pnpm licenses:check
pnpm test:licenses
pnpm licenses:report
```

The source check requires Git history back to the frozen baseline. It checks new
file labels and the unchanged Apache text, not ownership or whether modifications
qualify for copyright protection. Review imported material and changes to inherited
files manually. Keep third-party notices. JSON and binary files use adjacent
`.license` sidecars when a header is not possible.

The dependency workflow produces sanitized `production.json`, `all.json`, and
`review-required.json` in its `dependency-license-inventory` artifact. Review the
actual license files and applicable distribution obligations for every flagged
dependency. An `OR` expression can offer a permissible alternative. Flags identify
dependencies whose distribution obligations need review. Platform-specific packages
need a report on each release platform. The report does not cover the complete
lockfile, native Gradle or CocoaPods dependencies, container operating systems,
downloaded SDKs, or fonts.

The initial local inventory flagged libvips under LGPL, lightningcss under MPL,
elkjs under EPL, Sentry build tools under FSL, caniuse-lite under CC-BY, and
react-native-fit-image under Beerware. `khroma@2.1.0` lacks license metadata, but
its installed `license` file contains MIT terms. Verify the actual packaged
version before recording any exception. The inherited
`apps/www/public/fonts/aeonik-medium.woff` has no separate license document in
this checkout. Establish redistribution rights or replace it before publication.

## Verify distributions and publish

The desktop configuration and selected Dockerfiles include the root license
bundle. Inspect the built artifacts before release, including Apache and
third-party attribution. Ship the applicable license texts, scope map, and notices
inside each independently published npm package. Mobile store artifacts need a separate native
dependency and attribution review.

Build and visually inspect the website, including `/license/`, `/license.md`,
pricing, and terms. Confirm the public sales channel and quotation process, then
obtain the maintainer's deployment authorization after counsel approves the
texts. Do not mark the published page, CLA integration, native release notices,
or legal approval complete on the strength of local tests.

## Primary references

- [Apache 2.0, section 4](https://www.apache.org/licenses/LICENSE-2.0)
- [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)
- [Open Source Definition, section 6](https://opensource.org/osd)
- [npm license metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [pnpm license inventory](https://pnpm.io/cli/licenses)
- [CLA Assistant setup and version changes](https://github.com/cla-assistant/cla-assistant)
- [Archived CLA GitHub Action](https://github.com/contributor-assistant/github-action)
