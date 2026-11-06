<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Ork licensing

Ork combines Apache-licensed material with new source-available work. New Ork
work is offered under [PolyForm Noncommercial 1.0.0](LICENSE-POLYFORM), with a
proposed monthly commercial license priced per named user. PolyForm Noncommercial
is not an OSI-approved open source license.

## Which terms apply

| Material | Terms |
| --- | --- |
| Material already in the Apache baseline described below | [Apache License 2.0](LICENSE), subject to any existing third-party notices |
| New Ork files marked `PolyForm-Noncommercial-1.0.0` | [PolyForm Noncommercial 1.0.0](LICENSE-POLYFORM), or a separate signed commercial agreement |
| New Ork changes in an inherited file marked `Apache-2.0 AND PolyForm-Noncommercial-1.0.0` | Apache for the inherited material, PolyForm Noncommercial for the new Ork changes, or a separate commercial agreement covering those changes |
| Imported libraries, fonts, generated material, and other third-party assets | Their own licenses and notices, which this document does not replace |

The original import is commit `dbbc5fc7f35f548ef0477b0ac0fedb586788fb5a`.
The Apache baseline for this transition is Ork commit
`7efb3c5e202ddb4a4da3cd07904cba7da4613d18`. Its existing material, including the
Ork changes already distributed there, keeps its existing terms. Unmarked
inherited files remain on those terms. A new name or location does not change
a file's provenance.

Existing Apache grants remain valid. Anyone can continue to use the Apache
baseline, including commercially, under Apache's conditions. PolyForm applies
only to new Ork work after that baseline.
Do not infer copyright ownership from a Git author, a rename, or an automated
comparison. Rights to imported assets need separate verification.

Each new original file carries an SPDX header. A file format that cannot carry
comments uses an adjacent `<filename>.license` file instead. A mixed header
records obligations for different contributions in a file. It does not put the
inherited Apache material under PolyForm or offer a choice to use all new work
under Apache. See [NOTICE](NOTICE) for attribution and the modification notice.

## Free and commercial use

PolyForm permits noncommercial purposes, the personal uses it describes, and use
by its listed noncommercial organizations. There is no blanket exemption for
companies. Internal automation for a for-profit business, customer support,
paid services, and a commercial hosted offering need a paid license for the
PolyForm-covered Ork work unless PolyForm expressly permits the use or
applicable law allows it.
The license text controls, including its express permission for listed
noncommercial organizations regardless of their funding.

The proposed commercial subscription charges monthly for each named person
(a seat), across the web, desktop, and mobile clients on deployments covered by
the order. Bots do not count as seats. Hosting and model services are separate
costs. Commercial use on your own server still requires seats for the people
using the PolyForm-covered work, unless their use is independently permitted.

The [FAQ](docs/licensing-faq.md) gives examples. The
[commercial license draft](docs/commercial-license.md) describes monthly billing,
seat assignment, and cancellation. It is pending legal review, and paid
subscriptions are not available for purchase yet. The per-seat price will be
agreed in the order. To request a private sales contact, open a
[licensing inquiry](https://github.com/orkbot-run/ork/issues/new) without personal,
customer, or contractual information. No paid rights are granted until an
agreement identifies the parties, covered software, scope, price, and term.

## Packages and distribution

Package metadata describes the material in that package, not a new license for
its dependencies. Apache-only packages keep `Apache-2.0`. Packages containing
both kinds of work use `Apache-2.0 AND PolyForm-Noncommercial-1.0.0` as aggregate
metadata. Individual file notices and this scope explanation control. Update
the metadata when adding the first PolyForm-covered contribution to a package.
Third-party licenses still apply independently.

Distribute `LICENSE`, `LICENSE-POLYFORM`, `LICENSE.md`, and `NOTICE` with mixed
builds, preserve file notices, and include any required third-party notices.
The dependency report inventories installed JavaScript packages. It does not
certify a release's compliance or cover system packages and all native assets.

The commercial agreement and contributor agreement remain drafts pending legal
review. Their publication and activation require the review described in
[the rollout instructions](docs/licensing-rollout.md). This explanation is not
legal advice.
