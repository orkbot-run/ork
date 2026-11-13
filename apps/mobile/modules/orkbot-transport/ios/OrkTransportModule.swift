// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import ExpoModulesCore

public final class OrkTransportModule: Module {
  private let contexts = InstallationContexts()

  public func definition() -> ModuleDefinition {
    Name("OrkTransport")
    AsyncFunction("start") { (session: String, revision: UInt64, id: String) async throws in
      try await self.contexts.start(session: session, revision: revision, id: id)
    }
    AsyncFunction("begin") { () async in await self.contexts.begin() }
    AsyncFunction("select") { (session: String, revision: UInt64, target: String) async throws in
      try await self.contexts.select(session: session, revision: revision, target: target)
    }
    AsyncFunction("open") { (session: String, revision: UInt64, id: String, input: String) async throws in
      try await self.contexts.open(session: session, revision: revision, id: id, input: input)
    }
    AsyncFunction("write") { (session: String, revision: UInt64, id: String, bytes: String) async throws -> Bool in
      try await self.contexts.write(session: session, revision: revision, id: id, bytes: bytes)
    }
    AsyncFunction("finish") { (session: String, revision: UInt64, id: String) async throws in
      try await self.contexts.finish(session: session, revision: revision, id: id)
    }
    AsyncFunction("head") { (session: String, revision: UInt64, id: String) async throws -> [String: Any] in
      let result = try await self.contexts.head(session: session, revision: revision, id: id)
      return ["status": Int(result.status), "headers": result.headers.map { ["name": $0.name, "value": $0.value] }]
    }
    AsyncFunction("read") { (session: String, revision: UInt64, id: String) async throws -> String? in
      try await self.contexts.read(session: session, revision: revision, id: id)
    }
    AsyncFunction("cancel") { (session: String, revision: UInt64, id: String) async in
      await self.contexts.cancel(session: session, revision: revision, id: id)
    }
    AsyncFunction("end") { (session: String) async in await self.contexts.end(session: session) }
    OnDestroy { Task { _ = await self.contexts.begin() } }
  }
}
