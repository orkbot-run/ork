// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Foundation

public enum InstallationRequestError: Error {
  case invalidTarget, closed
}

/// The platform owns the operation's lifetime; Rust owns its bounded socket and TLS channels.
public actor InstallationRequest {
  private let connection: InstallationConnection
  private var canceled = false
  private var completed = false

  public init(origin: String, serverId: String, bindingVersion: UInt64, fingerprint: String,
    relay: RelayRoute? = nil) throws {
    if let relay {
      connection = try InstallationConnection.viaRelay(origin: origin, serverId: serverId,
        bindingVersion: bindingVersion, keyFingerprint: fingerprint, route: relay)
    } else {
      connection = try InstallationConnection(origin: origin, serverId: serverId,
        bindingVersion: bindingVersion, keyFingerprint: fingerprint)
    }
  }

  public func start(_ request: HttpRequest) async throws {
    try await perform { try await $0.startRequest(request: request) }
  }

  public func writeBody(_ bytes: Data) async throws -> Bool {
    try await perform { try await $0.writeBody(bytes: bytes) }
  }

  public func finishBody() async throws {
    try await perform { try await $0.finishBody() }
  }

  public func responseHead() async throws -> HttpResponseHead {
    try await perform { try await $0.responseHead() }
  }

  public func readBody() async throws -> Data? {
    if completed { return nil }
    let bytes = try await perform { try await $0.readBody() }
    if bytes == nil { completed = true }
    return bytes
  }

  public func cancel() {
    canceled = true
    connection.cancel()
  }

  private func perform<T: Sendable>(
    _ operation: @Sendable (InstallationConnection) async throws -> T
  ) async throws -> T {
    if canceled { throw InstallationRequestError.closed }
    do {
      let value = try await operation(connection)
      if canceled { throw InstallationRequestError.closed }
      return value
    } catch {
      cancel()
      throw error
    }
  }

  deinit { connection.cancel() }
}
