// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import Foundation

private enum Failure: Error, Equatable {
  case signedOut, offline, verification, storage, unauthorized
}

private final class Probe {
  var saved: String? =
    #"{"botId":"saved","spaceId":"space","apiBase":"https://example.test","userId":"user"}"#
  var userId = "user"
  var readError: Failure?
  var identityError: Failure?
  var authorizationError: Failure?
  var available = true
  var current = true
  var switchDuringIdentity = false
  var switchDuringAuthorization = false
  var authorizations: [ShortcutBotTarget] = []

  func resolve(_ requested: ShortcutBotTarget? = nil) async throws -> ShortcutBotTarget? {
    try await resolveShortcutBot(
      requested, apiBase: "https://example.test",
      readSaved: {
        if let error = self.readError { throw error }
        return self.saved
      },
      currentUserId: {
        if let error = self.identityError { throw error }
        if self.switchDuringIdentity { self.current = false }
        return self.userId
      },
      requireCurrentSession: {
        if !self.current { throw ShortcutTargetError.sessionChanged }
      },
      authorize: { target in
        self.authorizations.append(target)
        if let error = self.authorizationError { throw error }
        if self.switchDuringAuthorization { self.current = false }
        return self.available
      })
  }
}

@main
private struct ShortcutTargetTests {
  static func check(_ condition: Bool, _ message: String) {
    precondition(condition, message)
  }

  static func rejects(_ expected: Failure, _ run: () async throws -> Void) async {
    do {
      try await run()
      preconditionFailure("Expected \(expected)")
    } catch let error as Failure { check(error == expected, "Failure identity changed") } catch {
      preconditionFailure("Unexpected error: \(error)")
    }
  }

  static func rejectsStale(_ probe: Probe, _ requested: ShortcutBotTarget? = nil) async {
    do {
      _ = try await probe.resolve(requested)
      preconditionFailure("Accepted a retired session")
    } catch ShortcutTargetError.sessionChanged {} catch {
      preconditionFailure("Unexpected stale error: \(error)")
    }
  }

  static func main() async throws {
    let expected = ShortcutBotTarget(botId: "saved", spaceId: "space")
    let success = Probe()
    let resolved = try await success.resolve()
    check(
      resolved == expected && success.authorizations == [expected], "Saved target not authorized")

    let absent = Probe()
    absent.saved = nil
    let missing = try await absent.resolve()
    check(missing == nil && absent.authorizations.isEmpty, "Missing target was not absent")
    let legacy = Probe()
    legacy.saved = "legacy-id"
    let old = try await legacy.resolve()
    check(old == nil, "Unverified legacy id was accepted")

    let otherUser = Probe()
    otherUser.userId = "other"
    let mismatch = try await otherUser.resolve()
    check(mismatch == nil && otherUser.authorizations.isEmpty, "Wrong account was authorized")
    let otherServer = Probe()
    otherServer.saved = #"{"botId":"saved","apiBase":"https://other.example.test","userId":"user"}"#
    let serverMismatch = try await otherServer.resolve()
    check(
      serverMismatch == nil && otherServer.authorizations.isEmpty, "Wrong server was authorized")

    for failure in [Failure.signedOut, .offline, .verification] {
      let probe = Probe()
      probe.identityError = failure
      await rejects(failure) { _ = try await probe.resolve() }
    }
    let storage = Probe()
    storage.readError = .storage
    await rejects(.storage) { _ = try await storage.resolve() }
    let malformed = Probe()
    malformed.saved = "{malformed"
    do {
      _ = try await malformed.resolve()
      preconditionFailure("Malformed record became no bot")
    } catch is DecodingError {}
    let invalid = Probe()
    invalid.userId = " "
    do {
      _ = try await invalid.resolve()
      preconditionFailure("Empty verification identity accepted")
    } catch ShortcutTargetError.invalidIdentity {}

    let before = Probe()
    before.current = false
    await rejectsStale(before)
    let identityRace = Probe()
    identityRace.switchDuringIdentity = true
    await rejectsStale(identityRace)
    check(identityRace.authorizations.isEmpty, "Retired identity reached authorization")
    let authorizationRace = Probe()
    authorizationRace.switchDuringAuthorization = true
    await rejectsStale(authorizationRace)

    let explicit = ShortcutBotTarget(botId: "explicit", spaceId: "selected")
    let chosen = Probe()
    chosen.readError = .storage
    let selected = try await chosen.resolve(explicit)
    check(
      selected == explicit && chosen.authorizations == [explicit],
      "Explicit target bypassed authorization")
    let unavailable = Probe()
    unavailable.available = false
    let notFound = try await unavailable.resolve(explicit)
    check(notFound == nil, "A missing explicit target was accepted")
    let missingRace = Probe()
    missingRace.available = false
    missingRace.switchDuringAuthorization = true
    await rejectsStale(missingRace, explicit)
    let denied = Probe()
    denied.authorizationError = .unauthorized
    await rejects(.unauthorized) { _ = try await denied.resolve(explicit) }
    let explicitOffline = Probe()
    explicitOffline.identityError = .offline
    await rejects(.offline) { _ = try await explicitOffline.resolve(explicit) }
    let explicitRace = Probe()
    explicitRace.switchDuringAuthorization = true
    await rejectsStale(explicitRace, explicit)
    print("20 shortcut target behaviors passed")
  }
}
