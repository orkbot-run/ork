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
    let endpoint = try JSONDecoder().decode(Endpoint.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    func operation(_ fingerprint: String? = nil) throws -> InstallationRequest {
      try InstallationRequest(origin: endpoint.origin, serverId: endpoint.serverId, bindingVersion: endpoint.bindingVersion, fingerprint: fingerprint ?? endpoint.fingerprint)
    }
    func get(_ path: String) -> HttpRequest {
      HttpRequest(method: "GET", path: path, headers: [HttpHeader(name: "authorization", value: "Bearer native-conformance-token")], hasBody: false)
    }
    let upload = try operation()
    try await upload.start(HttpRequest(method: "POST", path: "/files", headers: [HttpHeader(name: "authorization", value: "Bearer native-conformance-token")], hasBody: true))
    for _ in 0..<64 { try await upload.writeBody(Data(repeating: 0x42, count: 32 * 1024)) }
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
    print("PASS: native Swift/Rust HTTP, 2 MB upload/download, SSE, cancellation, pin refusal and opaque TCP relay")
  }
}
