# Content

Artifacts, pages, boards, search, and publicly shared page rendering live here, with ownership checks and attachment preparation for messages. Storage and page-runtime implementations stay in workspace packages, while conversation state belongs to `threads`.

`contentRoutes`, `pagesRoutes`, and `boardsRoutes` build RPC handlers. HTTP entrypoints are `mountSharedPages` and `mountScriptAssets`, with services including `createOwnedArtifact`, `listSpaceArtifacts`, `listPages`, and `querySpaceSearch`.
