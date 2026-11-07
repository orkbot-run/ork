// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import Foundation

struct ShortcutBotTarget: Equatable {
  let botId: String
  let spaceId: String?
}

/// The record written by lib/last-bot.ts. A legacy plain id has no verified owner.
private struct SavedShortcutBot: Decodable {
  let botId: String
  let spaceId: String?
  let apiBase: String
  let userId: String
}

enum ShortcutTargetError: Error {
  case sessionChanged
  case invalidIdentity
}

/// Platform reads and server verification throw; only a missing or mismatched target is nil.
func resolveShortcutBot(
  _ requested: ShortcutBotTarget?, apiBase: String,
  readSaved: () throws -> String?,
  currentUserId: () async throws -> String,
  requireCurrentSession: () throws -> Void,
  authorize: (ShortcutBotTarget) async throws -> Bool
) async throws -> ShortcutBotTarget? {
  try requireCurrentSession()
  let saved: SavedShortcutBot?
  if requested != nil {
    saved = nil
  } else {
    guard let raw = try readSaved() else { return nil }
    // The previous release stored an unscoped id. It cannot authorize a target.
    guard raw.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("{") else { return nil }
    saved = try JSONDecoder().decode(SavedShortcutBot.self, from: Data(raw.utf8))
  }
  let userId = try await currentUserId()
  try requireCurrentSession()
  guard !userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    throw ShortcutTargetError.invalidIdentity
  }
  if let saved, saved.userId != userId || saved.apiBase != apiBase { return nil }
  guard
    let candidate = requested
      ?? saved.map({ ShortcutBotTarget(botId: $0.botId, spaceId: $0.spaceId) }),
    !candidate.botId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  else { return nil }
  let available = try await authorize(candidate)
  try requireCurrentSession()
  return available ? candidate : nil
}
