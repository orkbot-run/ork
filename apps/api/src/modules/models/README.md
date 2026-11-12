<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Models

This module manages model credentials, connection setup, defaults, and model pins. It validates compatibility before changing a connection and records connection outcomes. Provider discovery and model communication stay in workspace adapters, while plan access and credit accounting belong to `billing`.

`modelsRoutes` builds the RPC handlers, with `createModelConnector` preparing connections and `persistModelCredential` saving credentials. Import flows use `createImportedModelCredential`, and pin checks are exported from `model-pins.ts`.

An organization owner can configure shared workspace models in the Ork app using API keys. Requests go directly to the workspace server. Secrets belong to the organization, are kept in the configured server-side secret store, and are never returned in the policy response. While shared models are configured, members can select only those models; personal choices remain saved for use after the policy is removed. A missing or unreadable workspace key fails the run instead of falling back to a personal key. Model changes apply to new calls; an already-open provider stream may finish on its original model. Both the API and workers must be updated after applying the database migration before using multiple shared models.
