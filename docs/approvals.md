<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Inherited documentation remains Apache-2.0; spending limit documentation is PolyForm-covered. -->

# Approvals

Decide how much a bot can do without asking you first.

## Choose a mode

Open **Settings → Approvals** and pick a **Mode**:

- **Ask**: the bot asks before any action that changes something, such as sending an email or
  editing a document. Reading usually doesn't ask.
- **Auto**: an approval model checks each action against what you asked for. Actions that fit go
  ahead; the bot asks when one is off-task, or can't be undone and you didn't ask for it.
- **Never ask**: every action runs without waiting.

**Auto** needs an **Approval model**, set in **Settings → Models**. See [Models](./models.md).

> [!TIP]
> Start with **Ask** or **Auto**. As you approve the same action again and again, choose
> **Always allow** on the card and the bot stops asking for that one.

## Approval cards

When a bot needs a yes, it posts a card in the chat showing exactly what it wants to do:

- **Allow once**: just this time.
- **Always allow this tool**, or **Always allow** a site: stop asking for it.
- **Deny**: the bot doesn't do it and carries on.

Cards never block the chat. Keep talking to the bot, and answer the card whenever you're ready. You
get a notification when a bot is waiting on you, if notifications are on in the bot's settings.

## Allow and Block lists

Every **Always allow** choice is saved in **Settings → Approvals**. Switch any entry between
**Allow** and **Block**, or **Remove** it. A blocked action is refused without a card, in every
mode. **Preview** shows what would happen for a given tool before you change anything.

To stop one bot from ever using a tool, open the bot's settings, expand **Advanced**, and use
**Disable a tool** under **Tools**.

## What always asks

In **Auto** and **Ask**, these always show a card, and **Always allow** doesn't skip it:

- Changing a bot's instructions or model, and creating a space.
- Actions that text you didn't write could be steering, such as changes in a run started by a
  webhook.
- A routine that watches a command, or that names a site the run found in outside content.

**Never ask** runs all of them. The one exception is accepting another owner's bot connection, which
it refuses when someone else started the run or outside content entered it.

## Per space

Approval settings are account defaults that every [space](./spaces.md) follows. To give one space
different rules, open its settings and choose **Customize** next to **Approvals**.

## Account spending limit

Open the account's **Settings → Approvals → Account spending limit** to set an amount, a currency
and a reset period. USD, EUR, GBP, ILS and PLN are supported. A zero limit blocks payments.
Remove the limit to allow spending without a cap.

The limit covers every bot and Space on your account. Space approval overrides cannot change it.
Daily limits reset at midnight UTC, weekly limits on Monday at midnight UTC, and monthly limits
on the first day of the month at midnight UTC. **Never** keeps the full payment history.
Changing or removing a limit keeps that history too.

A pay click recognized by the page browser counts at the amount shown in its approval card.
A wallet purchase counts at its exact requested amount. Filling its card or payment token and
then clicking Pay counts once. With a limit enabled, payments are blocked if the amount cannot
be read safely or the currency differs from the limit. Currency conversion is not supported.
A bare `$` does not identify a currency and is refused while a limit is enabled.

The server checks available funds before presenting an approval. Wallet requests reserve their
exact amount before contacting the wallet, then check again before exposing credentials or paying.
Page payments reserve funds immediately before the click. These checks share a per-user Postgres
advisory lock, so bots in different Spaces cannot each spend the same remaining funds.
Pending wallet purchases reserve funds until their outcome is known, including across a reset.
Rejected, expired, canceled and failed purchases release their reservations, as do page actions
that are definitely refused before the payment click. An uncertain network result keeps counting
because the merchant may already have charged the payment.

Settings show spent and reserved funds together. Security and organization audit logs record
limit changes and blocked attempts without storing page text or card details.
