<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Meetings

Ork can join Google Meet, Zoom, and Microsoft Teams as a named participant. It records audio and
imports a transcript with speaker names and timestamps. The person starting the meeting must
inform participants and have permission to record. The provider posts a recording notice in
meeting chat where supported. These steps are in addition to the meeting platform's own lobby
and recording controls.

## Enable meetings

Add these settings to the server environment and restart the API and the worker together.

| Setting | Value |
| --- | --- |
| `ORKBOT_MEETING_PROVIDER` | `recall` |
| `ORKBOT_MEETING_API_KEY` | API key for your meeting provider account |
| `ORKBOT_MEETING_REGION` | `eu-central-1`, `us-east-1`, `us-west-2`, or `ap-northeast-1` |
| `ORKBOT_MEETING_WEBHOOK_SECRET` | Workspace webhook verification secret |
| `ORKBOT_MEETING_SPACE_IDS` | Comma-separated Space IDs, or `*` to enable the feature in every Space |
| `ORKBOT_MEETING_DAILY_LIMIT` | Meetings per Space per UTC day, default 10 |
| `ORKBOT_MEETING_MAX_MINUTES` | Maximum audio recording duration, default 90 minutes |

Set `ORKBOT_MEETING_LEGACY_WEBHOOK_SECRET` only for a legacy endpoint using the separate Svix
signing secret. Register your server's HTTPS `/api/v1/meetings/webhook` endpoint with the provider
and subscribe to bot, recording, and transcript status events. Polling recovers missed events.
A blank provider or Space allowlist leaves the feature disabled.

## Use and retention

Paste a supported meeting link into a private bot chat and review the invitation, or open the
**Meetings** tab in the bot panel. The invitation can start now or be scheduled for a time shown
in your device's time zone. To use a connected calendar, ask the bot to find an event and schedule
attendance. The bot asks for explicit confirmation before it schedules a recording.

Only the owner who started the session can open its transcript. Ask the same bot in its private
chat about decisions or action items from the meeting. The transcript is stored under the
Space's content encryption policy. The provider retains audio for up to 24 hours. Ork asks it
to delete its copy after a successful import and repeats the request when necessary. Deleting
a meeting removes its transcript from the app and requests provider cleanup. Text quoted
previously in other chats or exported elsewhere is managed in those places.

## Offline verification

Run the browser scenario with the emulator. No provider credentials are needed.

```sh
ORKBOT_MEETING_PROVIDER=emulator ORKBOT_MEETING_SPACE_IDS='*' pnpm test:e2e --spec=meetings
```

The emulator is available in development and tests. The provider configuration and supported
regions are documented in the [meeting platform guide](https://docs.recall.ai/docs/meeting-platforms)
and [webhook verification guide](https://docs.recall.ai/docs/authenticating-requests-from-recallai).
