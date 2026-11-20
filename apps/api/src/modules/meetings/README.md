<!-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 -->
<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->

# Meetings

`meetingsRoutes` exposes owner-scoped meeting scheduling, history, transcripts, and deletion.
`mountMeetingWebhook` authenticates provider notifications and wakes the existing job queue.
The shared meeting service owns provider I/O, limits, and data retention.
