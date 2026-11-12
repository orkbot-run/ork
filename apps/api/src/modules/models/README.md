<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Models

This module manages model credentials, connection setup, defaults, and model pins. It validates compatibility before changing a connection and records connection outcomes. Provider discovery and model communication stay in workspace adapters, while plan access and credit accounting belong to `billing`.

`modelsRoutes` builds the RPC handlers, with `createModelConnector` preparing connections and `persistModelCredential` saving credentials. Import flows use `createImportedModelCredential`, and pin checks are exported from `model-pins.ts`.

An organization owner can set a workspace model using an API key. Its secret belongs to the organization, is stored through the configured secret store, and is never returned in the policy response. A configured policy takes precedence over members' choices and bot pins; personal choices remain saved for use after the policy is removed. A missing or unreadable workspace key fails the run instead of falling back to a personal key. Model changes apply to new calls; an already-open provider stream may finish on its original model. Both the API and workers must be updated after applying the database migration before enabling the policy.

`dashboardModelControl` accepts only a short-lived, single-use Accounts grant bound to the server, active workspace connection, action and request body. Ordinary app sessions cannot change the policy. The dashboard forwards keys to this server without storing them in Accounts.
