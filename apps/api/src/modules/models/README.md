<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Models

This module manages model credentials, connection setup, defaults, and model pins. It validates compatibility before changing a connection and records connection outcomes. Provider discovery and model communication stay in workspace adapters, while plan access and credit accounting belong to `billing`.

`modelsRoutes` builds the RPC handlers, with `createModelConnector` preparing connections and `persistModelCredential` saving credentials. Import flows use `createImportedModelCredential`, and pin checks are exported from `model-pins.ts`.
