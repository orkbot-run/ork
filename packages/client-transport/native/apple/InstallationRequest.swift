// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Foundation

private final class InstallationSocketDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

public enum InstallationRequestError: Error {
  case invalidTarget, invalidIdentity, alreadyStarted, closed
}

private struct InstallationSocketIdentity: Decodable {
  let `protocol`: String
  let serverId: String
  let bindingVersion: UInt64
  let keyFingerprint: String
  let certificate: String
}

/// Owns one HTTP operation and its socket. The caller cancels it when its account or workspace closes.
public actor InstallationRequest {
  private let origin: String
  private let address: URL
  private let serverId: String
  private let bindingVersion: UInt64
  private let fingerprint: String
  private var session: URLSession?
  private var socket: URLSessionWebSocketTask?
  private var channel: InstallationHttp?
  private var pumps: [Task<Void, Never>] = []
  private var started = false
  private var canceled = false
  private var completed = false

  public init(origin: String, serverId: String, bindingVersion: UInt64, fingerprint: String) throws {
    guard let id = UUID(uuidString: serverId), id.uuidString.lowercased() == serverId,
      bindingVersion > 0,
      fingerprint.utf8.count == 64,
      fingerprint.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
      var url = URLComponents(string: origin), url.string == origin,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty, url.host != nil,
      url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "[::1]"].contains(url.host!))
    else { throw InstallationRequestError.invalidTarget }
    url.scheme = url.scheme == "https" ? "wss" : "ws"
    url.path = "/api/installation-transport/v1"
    guard let address = url.url else { throw InstallationRequestError.invalidTarget }
    self.origin = origin
    self.address = address
    self.serverId = serverId
    self.bindingVersion = bindingVersion
    self.fingerprint = fingerprint
  }

  public func start(_ request: HttpRequest) async throws {
    guard !canceled else { throw InstallationRequestError.closed }
    guard !started else { throw InstallationRequestError.alreadyStarted }
    started = true
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    let session = URLSession(configuration: configuration, delegate: InstallationSocketDelegate(), delegateQueue: nil)
    self.session = session
    var upgrade = URLRequest(url: address)
    upgrade.setValue("orkbot://", forHTTPHeaderField: "Origin")
    let socket = session.webSocketTask(with: upgrade)
    socket.maximumMessageSize = 256 * 1024
    self.socket = socket
    socket.resume()
    do {
      let first = try await socket.receive()
      try requireOpen()
      guard case .string(let text) = first, text.utf8.count <= 32 * 1024,
        let data = text.data(using: .utf8) else { throw InstallationRequestError.invalidIdentity }
      let identity = try JSONDecoder().decode(InstallationSocketIdentity.self, from: data)
      guard identity.protocol == "ork-installation-tls-v1", identity.serverId == serverId,
        identity.bindingVersion == bindingVersion, identity.keyFingerprint == fingerprint,
        let certificate = Data(base64Encoded: identity.certificate), certificate.count <= 16 * 1024
      else { throw InstallationRequestError.invalidIdentity }
      // The expected fingerprint comes from the selected catalog entry, never from the socket.
      let channel = try InstallationHttp(certificate: certificate, keyFingerprint: fingerprint, origin: origin)
      self.channel = channel
      try await channel.startRequest(input: request)
      try requireOpen()
      pumps = [
        Task.detached {
          do {
            while let bytes = try await channel.takeEncrypted() {
              try await socket.send(.data(bytes))
            }
          } catch {
            socket.cancel(with: .goingAway, reason: nil)
            try? await channel.finishIncoming()
          }
        },
        Task.detached {
          do {
            while !Task.isCancelled {
              guard case .data(let bytes) = try await socket.receive(), bytes.count <= 256 * 1024
              else { throw InstallationRequestError.invalidIdentity }
              try await channel.putEncrypted(bytes: bytes)
            }
          } catch {
            try? await channel.finishIncoming()
          }
        },
      ]
    } catch {
      cancel()
      throw error
    }
  }

  public func writeBody(_ bytes: Data) async throws {
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
    if bytes == nil {
      completed = true
      closeNetwork()
    }
    return bytes
  }

  public func cancel() {
    canceled = true
    channel?.cancel()
    closeNetwork()
  }

  private func requireOpen() throws {
    if canceled { throw InstallationRequestError.closed }
  }

  private func perform<T: Sendable>(
    _ operation: @Sendable (InstallationHttp) async throws -> T
  ) async throws -> T {
    try requireOpen()
    guard let channel else { throw InstallationRequestError.closed }
    do {
      let value = try await operation(channel)
      try requireOpen()
      return value
    } catch {
      cancel()
      throw error
    }
  }

  private func closeNetwork() {
    channel?.cancel()
    for pump in pumps { pump.cancel() }
    pumps.removeAll()
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    session?.invalidateAndCancel()
    session = nil
  }

  deinit {
    channel?.cancel()
    for pump in pumps { pump.cancel() }
    socket?.cancel(with: .goingAway, reason: nil)
    session?.invalidateAndCancel()
  }
}
