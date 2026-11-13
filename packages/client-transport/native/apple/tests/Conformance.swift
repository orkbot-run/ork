// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Foundation

struct Endpoint: Decodable {
  let origin: String
  let serverId: String
  let bindingVersion: UInt64
  let fingerprint: String
}
struct Check: Decodable { let uploads: Int; let canceled: Int; let opaque: Bool }

@main struct Conformance {
  static func main() async {
    do { try await verify() }
    catch {
      FileHandle.standardError.write(Data("Native conformance failed: \(error)\n".utf8))
      exit(1)
    }
  }

  static func verify() async throws {
    try verifyNotificationRequests()
    let endpoint = try JSONDecoder().decode(Endpoint.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    func operation(_ fingerprint: String? = nil) throws -> InstallationRequest {
      try InstallationRequest(origin: endpoint.origin, serverId: endpoint.serverId, bindingVersion: endpoint.bindingVersion, fingerprint: fingerprint ?? endpoint.fingerprint)
    }
    func get(_ path: String) -> HttpRequest {
      HttpRequest(method: "GET", path: path, headers: [HttpHeader(name: "authorization", value: "Bearer native-conformance-token")], hasBody: false)
    }
    let upload = try operation()
    try await upload.start(HttpRequest(method: "POST", path: "/files", headers: [HttpHeader(name: "authorization", value: "Bearer native-conformance-token")], hasBody: true))
    for _ in 0..<64 {
      guard try await upload.writeBody(Data(repeating: 0x42, count: 32 * 1024)) else { fatalError("upload refused") }
    }
    try await upload.finishBody()
    let head = try await upload.responseHead()
    guard head.status == 201 else { fatalError("wrong status") }
    var size = 0
    while let bytes = try await upload.readBody() {
      guard bytes.count <= 64 * 1024, bytes.allSatisfy({ $0 == 0x43 }) else { fatalError("wrong download") }
      size += bytes.count
    }
    guard size == 2 * 1024 * 1024 else { fatalError("incomplete file") }
    let events = try operation()
    try await events.start(get("/events"))
    _ = try await events.responseHead()
    var stream = Data()
    while let bytes = try await events.readBody() { stream.append(bytes) }
    guard String(data: stream, encoding: .utf8) == "data: private-event-first\n\ndata: private-event-last\n\n" else { fatalError("wrong stream") }
    let cancel = try operation()
    try await cancel.start(get("/cancel"))
    _ = try await cancel.responseHead()
    guard try await cancel.readBody() != nil else { fatalError("missing first event") }
    let waiting = Task { try await cancel.readBody() }
    await cancel.cancel()
    do { _ = try await waiting.value; fatalError("cancellation ignored") } catch {}
    let wrong = try operation(String(repeating: "0", count: 64))
    do { try await wrong.start(get("/private")); fatalError("wrong pin accepted") } catch {}
    let checks = try operation()
    try await checks.start(get("/checks")); _ = try await checks.responseHead()
    var data = Data()
    while let bytes = try await checks.readBody() { data.append(bytes) }
    let result = try JSONDecoder().decode(Check.self, from: data)
    guard result.uploads == 1, result.canceled == 1, result.opaque else { fatalError("failed checks") }
    let contexts = InstallationContexts()
    let session = await contexts.begin()
    let target = String(data: try JSONSerialization.data(withJSONObject: [
      "account": "[\"https://accounts.example.test\",\"native-user\"]",
      "origin": "https://\(endpoint.serverId).installation.ork.invalid",
      "directOrigin": endpoint.origin,
      "organizationId": "20000000-0000-4000-8000-000000000001",
      "serverId": endpoint.serverId,
      "workspaceId": "30000000-0000-4000-8000-000000000001",
      "bindingVersion": endpoint.bindingVersion,
      "keyFingerprint": endpoint.fingerprint,
    ]), encoding: .utf8)!
    func input(_ path: String) throws -> String {
      String(data: try JSONSerialization.data(withJSONObject: [
        "method": "GET", "path": path, "hasBody": false,
        "headers": [["name": "authorization", "value": "Bearer native-conformance-token"]],
      ]), encoding: .utf8)!
    }
    func refuses(_ operation: () async throws -> Void) async {
      do { try await operation(); fatalError("stale native context accepted") } catch {}
    }
    try await contexts.select(session: session, revision: 2, target: target)
    let prepared = UUID().uuidString.lowercased()
    try await contexts.open(session: session, revision: 2, id: prepared, input: input("/events"))
    await contexts.cancel(session: session, revision: 2, id: prepared)
    await refuses { try await contexts.start(session: session, revision: 2, id: prepared) }
    await refuses { try await contexts.select(session: session, revision: 1, target: target) }
    let oldId = UUID().uuidString.lowercased()
    try await contexts.open(session: session, revision: 2, id: oldId, input: input("/cancel"))
    try await contexts.start(session: session, revision: 2, id: oldId)
    _ = try await contexts.head(session: session, revision: 2, id: oldId)
    guard try await contexts.read(session: session, revision: 2, id: oldId) != nil else { fatalError("missing scoped event") }
    let late = Task { try await contexts.read(session: session, revision: 2, id: oldId) }
    await Task.yield()
    try await contexts.select(session: session, revision: 3, target: target)
    await refuses { _ = try await late.value }
    await refuses { _ = try await contexts.head(session: session, revision: 2, id: oldId) }
    await refuses { try await contexts.select(session: session, revision: 2, target: target) }
    let replacement = await contexts.begin()
    try await contexts.select(session: replacement, revision: 1, target: target)
    await contexts.end(session: session)
    let newId = UUID().uuidString.lowercased()
    try await contexts.open(session: replacement, revision: 1, id: newId, input: input("/events"))
    try await contexts.start(session: replacement, revision: 1, id: newId)
    guard try await contexts.head(session: replacement, revision: 1, id: newId).status == 200 else { fatalError("new context closed by stale logout") }
    while try await contexts.read(session: replacement, revision: 1, id: newId) != nil {}
    await contexts.end(session: replacement)
    print("PASS: native Swift/Rust HTTP, files, SSE, cancellation, pins, opaque relay, selection fencing and notification scope")
  }

  static func verifyNotificationRequests() throws {
    let requests = NotificationRequests()
    let endpoint = "https://a0000000-0000-4000-8000-000000000001.installation.ork.invalid"
    let first = UUID().uuidString.lowercased()
    let second = UUID().uuidString.lowercased()
    var event: [String: String] = [:]
    let dispatcher = requests.install { event = $0 }
    defer { requests.uninstall(dispatcher) }
    guard NotificationRequests.isInstallationEndpoint(endpoint) else { fatalError("canonical endpoint refused") }
    for invalid in [endpoint + "/", endpoint + ":443", endpoint + "?q=1", endpoint + "#fragment", endpoint.uppercased(), endpoint + ".", endpoint.replacingOccurrences(of: "https://", with: "https://user@")] {
      guard !NotificationRequests.isInstallationEndpoint(invalid), NotificationRequests.isReservedEndpoint(invalid) else { fatalError("noncanonical installation route accepted") }
    }
    var cold: Int?
    requests.decline(endpoint: endpoint, token: "product-session-fixture", callId: "call-fixture") { cold = $0 }
    guard cold == 401, event.isEmpty else { fatalError("persisted session gained background authority") }
    try requests.configure(first, endpoint: endpoint, token: "product-session-fixture", space: "")
    var old: Int?
    requests.decline(endpoint: endpoint, token: "product-session-fixture", callId: "call-fixture") { old = $0 }
    guard event["scope"] == first, event["procedure"] == "notifications/declineIncomingCall", !event.values.contains("product-session-fixture") else { fatalError("wrong notification dispatch") }
    let retired = event
    try requests.configure(second, endpoint: endpoint, token: "replacement-product-session", space: "")
    guard old == 401 else { fatalError("scope replacement retained pending decline") }
    try requests.reply(retired["id"]!, scope: first, status: 200, body: "retired")
    guard old == 401 else { fatalError("retired response delivered") }
    var result: Int?
    requests.decline(endpoint: endpoint, token: "replacement-product-session", callId: "call-fixture") { result = $0 }
    try requests.reply(event["id"]!, scope: first, status: 200, body: "wrong-owner")
    guard result == nil else { fatalError("wrong reply owner accepted") }
    do {
      try requests.reply(event["id"]!, scope: second, status: 200, body: String(repeating: "é", count: 8 * 1024 * 1024 + 1))
      fatalError("oversized response accepted")
    } catch {}
    try requests.reply(event["id"]!, scope: second, status: 200, body: "{\"json\":{\"ok\":true}}")
    guard result == 200 else { fatalError("current decline did not complete") }
    result = nil
    requests.decline(endpoint: endpoint, token: "replacement-product-session", callId: "call-fixture") { result = $0 }
    requests.clear()
    guard result == 401 else { fatalError("logout retained pending decline") }
  }
}
