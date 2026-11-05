<!-- SPDX-FileCopyrightText: 2026 Rakazo contributors -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Apache-2.0 covers the inherited guide. Ork revisions are PolyForm-covered. -->
<!-- Modified by Ork contributors to document the mobile routine editor. -->

# Routines

A routine is a prompt a bot runs on its own: on a schedule, when something changes, or when another
service calls it.

## Ask for one in chat

The quickest way is to ask:

- "Every weekday at 8am, summarize my inbox."
- "Remind me in 20 minutes to call Dana."
- "Every Monday, check our competitors' pricing pages and tell me what changed."

The bot creates the routine and reports each run back in the same chat.

## Create or edit one yourself

Open the bot's computer with **Agent computer** at the top of the chat. Below the screen is the
bot's **Routines** list. Choose **Create Routine** (the **+**), or click a routine to edit it.

1. **Name** the routine and write the **Instruction**: what it should do each time it runs.
2. Under **When to run**, choose **Add trigger**.
3. Choose **Save**.

Under **Advanced** you can give a routine its own **Model** and **Thinking** level, for example a
cheaper model for a simple daily check.

## Triggers

### On a schedule

Every hour, every day, weekdays, every week, every month, or a custom interval. **Advanced...**
accepts a cron expression. Times use your timezone, set in **Settings → General**.

### When something changes

The bot checks something at a set interval (**Check every**, from 5 minutes to a day) and runs only
when it changed. **What to watch** can be files or folders on the computer, a command's output, or a
tool from a connected app. Turn on **Post "No changes" in chat** if you want a note every time. A
watch can't be combined with a schedule.

### Webhook

Gives you a URL and key. Any service that can send a POST request can start the routine.

### Git event

Gives you a URL to add as a GitHub webhook, so pushes, issues and pull requests can start the
routine.

### Slack message

Runs when the bot receives a message in Slack. Needs [Slack connected](./messaging-apps.md).

> [!NOTE]
> Runs started by a webhook or an outside message follow stricter [approval](./approvals.md) rules,
> since outside text could steer what the bot does.

## Test, pause and review

- **Test run** runs a saved routine now.
- Turn off **Active** to pause a routine without deleting it.
- **Run history** shows each past run and its result.
- A running routine shows **Running** in the list, with **Stop**.

## On mobile

Open a bot's profile to see its routines. Tap **+** to create one, or open an existing
routine to view its instruction, schedule, next run and run history. You can pause it
or start a test run there. **Edit routine** lets you change its name, instruction and
schedules, or delete it.

Configure webhook, Git event, Slack message and change triggers in chat or on the web
or desktop app. Set a routine's own model there too. Mobile displays these settings
and preserves them when you edit the routine.
