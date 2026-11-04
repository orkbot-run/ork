# Bots

Bot creation, settings, removal, and membership routes live here. The team-chat bridge handles ambient messages, engagement decisions, and startup retries. External delivery parsing stays in `messaging`, and message persistence and run control stay in `threads`.

`botsRoutes` builds the RPC handlers. `createBotRemoval` coordinates cleanup, while `TeamChatBridge`, `TeamChatStartupRetries`, and `ModelTeamChatEngagementJudge` provide the team-chat services assembled by the application.
