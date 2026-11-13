// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Foundation

/// A native decline uses the live app's pinned channel and never a persisted raw HTTP route.
final class NotificationRequests: @unchecked Sendable {
  static let shared = NotificationRequests()
  private struct Owner: Equatable { let id: String; let endpoint: String; let token: String }
  private struct Pending {
    let owner: Owner
    let completion: (Int) -> Void
    let timeout: DispatchWorkItem
  }
  private let lock = NSLock()
  private var dispatcher: (id: UUID, send: ([String: String]) -> Void)?
  private var owners: [String: Owner] = [:]
  private var order: [String] = []
  private var pending: [String: Pending] = [:]
  enum Failure: Error { case invalidRequest }

  static func isInstallationEndpoint(_ endpoint: String) -> Bool {
    guard let host = URLComponents(string: endpoint)?.host,
      host.hasSuffix(".installation.ork.invalid"),
      let server = UUID(uuidString: String(host.dropLast(".installation.ork.invalid".count)))
    else { return false }
    return endpoint == "https://\(server.uuidString.lowercased()).installation.ork.invalid"
  }

  static func isReservedEndpoint(_ endpoint: String) -> Bool {
    URLComponents(string: endpoint)?.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
      .hasSuffix(".installation.ork.invalid") == true
  }

  func install(_ send: @escaping ([String: String]) -> Void) -> UUID {
    lock.lock()
    let canceled = removeAllLocked()
    let id = UUID()
    dispatcher = (id, send)
    lock.unlock()
    cancel(canceled)
    return id
  }

  func uninstall(_ id: UUID) {
    lock.lock()
    guard dispatcher?.id == id else { lock.unlock(); return }
    dispatcher = nil
    let canceled = removeAllLocked()
    lock.unlock()
    cancel(canceled)
  }

  func configure(_ id: String, endpoint: String, token: String, space: String) throws {
    guard UUID(uuidString: id)?.uuidString.lowercased() == id,
      Self.isInstallationEndpoint(endpoint), !token.isEmpty, token.utf8.count <= 64 * 1024,
      space.isEmpty else { throw Failure.invalidRequest }
    let next = Owner(id: id, endpoint: endpoint, token: token)
    lock.lock()
    if owners[id] == next { lock.unlock(); return }
    var retired = Set(owners.values.filter { $0.id == id || $0.endpoint == endpoint }.map(\.id))
    if order.count >= 4, let first = order.first { retired.insert(first) }
    let canceled = pending.filter { retired.contains($0.value.owner.id) }
    for key in canceled.keys { pending.removeValue(forKey: key) }
    for key in retired { owners.removeValue(forKey: key) }
    order.removeAll { retired.contains($0) }
    owners[id] = next
    order.append(id)
    lock.unlock()
    cancel(Array(canceled.values))
  }

  func clear() {
    lock.lock()
    let canceled = removeAllLocked()
    lock.unlock()
    cancel(canceled)
  }

  func decline(endpoint: String, token: String, callId: String, completion: @escaping (Int) -> Void) {
    guard Self.isInstallationEndpoint(endpoint), !callId.isEmpty, callId.utf8.count <= 2048,
      let input = try? JSONSerialization.data(withJSONObject: ["callId": callId]),
      let json = String(data: input, encoding: .utf8) else { completion(400); return }
    lock.lock()
    guard let owner = owners.values.first(where: { $0.endpoint == endpoint && $0.token == token }),
      let send = dispatcher?.send else { lock.unlock(); completion(401); return }
    guard pending.count < 8 else { lock.unlock(); completion(503); return }
    let id = UUID().uuidString.lowercased()
    let timeout = DispatchWorkItem { [weak self] in self?.finish(id, status: 503) }
    pending[id] = Pending(owner: owner, completion: completion, timeout: timeout)
    lock.unlock()
    DispatchQueue.global().asyncAfter(deadline: .now() + 8, execute: timeout)
    send(["id": id, "scope": owner.id, "procedure": "notifications/declineIncomingCall", "input": json])
  }

  func reply(_ id: String, scope: String, status: Int, body: String) throws {
    guard (200...599).contains(status), body.utf8.count <= 16 * 1024 * 1024 else { throw Failure.invalidRequest }
    lock.lock()
    guard let request = pending[id], request.owner.id == scope, owners[scope] == request.owner
    else { lock.unlock(); return }
    pending.removeValue(forKey: id)
    lock.unlock()
    request.timeout.cancel()
    request.completion(status)
  }

  private func finish(_ id: String, status: Int) {
    lock.lock()
    let request = pending.removeValue(forKey: id)
    lock.unlock()
    request?.completion(status)
  }

  private func removeAllLocked() -> [Pending] {
    let requests = Array(pending.values)
    pending.removeAll()
    owners.removeAll()
    order.removeAll()
    return requests
  }

  private func cancel(_ requests: [Pending]) {
    for request in requests { request.timeout.cancel(); request.completion(401) }
  }
}
