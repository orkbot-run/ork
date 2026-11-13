// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Foundation

private struct InstallationSelection: Decodable, Equatable {
  let account: String
  let origin: String
  let organizationId: String
  let serverId: String
  let workspaceId: String
  let bindingVersion: UInt64
  let keyFingerprint: String
}

private struct InstallationHeader: Decodable {
  let name: String
  let value: String
}

private struct InstallationInput: Decodable {
  let method: String
  let path: String
  let headers: [InstallationHeader]
  let hasBody: Bool
}

/// A native session and monotonic selection revision fence every pending request.
public actor InstallationContexts {
  private var session = UUID().uuidString.lowercased()
  private var revision: UInt64 = 0
  private var selection: InstallationSelection?
  private var requests: [String: InstallationRequest] = [:]
  private var inputs: [String: HttpRequest] = [:]

  public func begin() async -> String {
    let previous = requests
    requests = [:]
    inputs = [:]
    selection = nil
    revision = 0
    session = UUID().uuidString.lowercased()
    let result = session
    await cancelAll(previous)
    return result
  }

  public func select(session: String, revision: UInt64, target: String) async throws {
    guard self.session == session, revision > 0, revision >= self.revision,
      target.utf8.count <= 8192, let data = target.data(using: .utf8)
    else { throw InstallationRequestError.closed }
    let selected = try JSONDecoder().decode(InstallationSelection.self, from: data)
    guard let owner = try JSONSerialization.jsonObject(with: Data(selected.account.utf8)) as? [String],
      owner.count == 2, owner.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 2048 }),
      let issuer = URLComponents(string: owner[0]), issuer.scheme == "https", issuer.host != nil,
      issuer.user == nil, issuer.password == nil, issuer.query == nil, issuer.fragment == nil,
      let origin = URLComponents(string: selected.origin),
      !(origin.scheme == "https" && origin.host?.lowercased() == issuer.host?.lowercased() &&
        (origin.port ?? 443) == (issuer.port ?? 443))
    else { throw InstallationRequestError.invalidTarget }
    for id in [selected.organizationId, selected.workspaceId] {
      guard UUID(uuidString: id)?.uuidString.lowercased() == id
      else { throw InstallationRequestError.invalidTarget }
    }
    _ = try InstallationRequest(origin: selected.origin, serverId: selected.serverId,
      bindingVersion: selected.bindingVersion, fingerprint: selected.keyFingerprint)
    if revision == self.revision {
      guard selected == selection else { throw InstallationRequestError.closed }
      return
    }
    let previous = requests
    requests = [:]
    inputs = [:]
    selection = selected
    self.revision = revision
    await cancelAll(previous)
    try requireCurrent(session, revision)
  }

  public func open(session: String, revision: UInt64, id: String, input: String) async throws {
    try requireCurrent(session, revision)
    guard let selection, requests[id] == nil,
      UUID(uuidString: id)?.uuidString.lowercased() == id,
      input.utf8.count <= 64 * 1024, let data = input.data(using: .utf8)
    else { throw InstallationRequestError.invalidTarget }
    let decoded = try JSONDecoder().decode(InstallationInput.self, from: data)
    let operation = try InstallationRequest(origin: selection.origin, serverId: selection.serverId,
      bindingVersion: selection.bindingVersion, fingerprint: selection.keyFingerprint)
    requests[id] = operation
    inputs[id] = HttpRequest(method: decoded.method, path: decoded.path,
      headers: decoded.headers.map { HttpHeader(name: $0.name, value: $0.value) }, hasBody: decoded.hasBody)
  }

  public func start(session: String, revision: UInt64, id: String) async throws {
    try requireCurrent(session, revision)
    guard let input = inputs.removeValue(forKey: id) else { throw InstallationRequestError.closed }
    try await perform(session, revision, id) { operation in
      try await operation.start(input)
    }
  }

  public func write(session: String, revision: UInt64, id: String, bytes: String) async throws -> Bool {
    guard bytes.utf8.count <= 88 * 1024, let data = Data(base64Encoded: bytes), data.count <= 64 * 1024
    else { throw InstallationRequestError.invalidTarget }
    return try await perform(session, revision, id) { try await $0.writeBody(data) }
  }

  public func finish(session: String, revision: UInt64, id: String) async throws {
    try await perform(session, revision, id) { try await $0.finishBody() }
  }

  public func head(session: String, revision: UInt64, id: String) async throws -> HttpResponseHead {
    try await perform(session, revision, id) { try await $0.responseHead() }
  }

  public func read(session: String, revision: UInt64, id: String) async throws -> String? {
    let bytes = try await perform(session, revision, id) { try await $0.readBody() }
    if bytes == nil { await cancel(session: session, revision: revision, id: id) }
    return bytes?.base64EncodedString()
  }

  public func cancel(session: String, revision: UInt64, id: String) async {
    guard self.session == session, self.revision == revision else { return }
    inputs[id] = nil
    if let operation = requests.removeValue(forKey: id) { await operation.cancel() }
  }

  public func end(session: String) async {
    guard self.session == session else { return }
    _ = await begin()
  }

  private func requireCurrent(_ session: String, _ revision: UInt64) throws {
    if self.session != session || self.revision != revision || selection == nil {
      throw InstallationRequestError.closed
    }
  }

  private func perform<T: Sendable>(
    _ session: String, _ revision: UInt64, _ id: String,
    _ action: @Sendable (InstallationRequest) async throws -> T
  ) async throws -> T {
    try requireCurrent(session, revision)
    guard let operation = requests[id] else { throw InstallationRequestError.closed }
    do {
      let result = try await action(operation)
      try requireCurrent(session, revision)
      guard requests[id] === operation else { throw InstallationRequestError.closed }
      return result
    } catch {
      if requests[id] === operation { requests[id] = nil; inputs[id] = nil }
      await operation.cancel()
      throw error
    }
  }

  private func cancelAll(_ operations: [String: InstallationRequest]) async {
    await withTaskGroup(of: Void.self) { group in
      for operation in operations.values { group.addTask { await operation.cancel() } }
    }
  }
}
