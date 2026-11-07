// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; session-bound preview suppression is an Ork addition.

import Intents
import UserNotifications

private let maxAvatarCharacters = 1400

final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private let lock = NSLock()
  private var fallback: UNNotificationContent?
  private var pushScope = ""
  private var hasSession: Bool {
    !pushScope.isEmpty && UserDefaults(suiteName: "group.run.orkbot.app")?.string(forKey: "orkbot.message-session") == pushScope
  }

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    fallback = request.content
    let data = request.content.userInfo["body"] as? [AnyHashable: Any] ?? request.content.userInfo
    pushScope = data["sessionScope"] as? String ?? ""
    guard hasSession else { finish(UNMutableNotificationContent()); return }
    guard let sender = data["sender"] as? [String: Any],
          let botId = sender["botId"] as? String,
          let name = sender["name"] as? String,
          !botId.isEmpty, !name.isEmpty else {
      finish(request.content)
      return
    }
    let encoded = sender["avatar"] as? String ?? ""
    let image = encoded.count <= maxAvatarCharacters
      ? Data(base64Encoded: encoded).flatMap { $0.isEmpty ? nil : INImage(imageData: $0) }
      : nil
    let person = INPerson(
      personHandle: INPersonHandle(value: botId, type: .unknown),
      nameComponents: nil, displayName: name, image: image,
      contactIdentifier: nil, customIdentifier: botId
    )
    let intent = INSendMessageIntent(
      recipients: nil, outgoingMessageType: .outgoingMessageText,
      // The title says why it alerted ("… failed"), so it stays as the heading above the sender.
      content: request.content.body,
      speakableGroupName: request.content.title.isEmpty ? nil : INSpeakableString(spokenPhrase: request.content.title),
      conversationIdentifier: data["threadId"] as? String,
      serviceName: nil, sender: person, attachments: nil
    )
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { [weak self] _ in
      guard let self else { return }
      self.finish((try? request.content.updating(from: intent)) ?? request.content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let fallback { finish(fallback) }
  }

  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    let completion = handler
    handler = nil
    lock.unlock()
    // The app group carries only an active-session marker, never authentication material.
    // Recheck after asynchronous intent donation too, so logout suppresses a late completion.
    completion?(hasSession ? content : UNMutableNotificationContent())
  }
}
