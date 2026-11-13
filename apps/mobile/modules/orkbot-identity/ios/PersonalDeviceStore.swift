// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import CryptoKit
import Foundation
import Security

private enum PersonalDeviceFailure: Error { case unavailable }
private func refused() -> PersonalDeviceFailure { .unavailable }
private let service = "run.orkbot.personal-device.v1"
private let keyPrefix = "run.orkbot.personal-key.v1."

private struct PersonalTarget: Codable, Equatable {
  let organizationId: String
  let serverId: String
  let workspaceId: String
  let bindingVersion: UInt64
  let keyFingerprint: String
  func validate() throws {
    guard [organizationId, serverId, workspaceId].allSatisfy({ uuid($0) }),
      bindingVersion > 0, bindingVersion <= 9_007_199_254_740_991, hex(keyFingerprint) else { throw refused() }
  }
  func scopeHash() throws -> String {
    try hash(JSONSerialization.data(withJSONObject: [
      "ork-personal-target-v1", organizationId, serverId, workspaceId, bindingVersion, keyFingerprint,
    ]))
  }
}
private struct PersonalRecord: Codable {
  let scope: String
  let id: String
  let target: PersonalTarget
  var descriptor: String?
}
private func uuid(_ value: String) -> Bool {
  value == value.lowercased() && value.count == 36 && UUID(uuidString: value) != nil
}
private func hex(_ value: String) -> Bool {
  value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
private func encoded(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
private func decoded(_ value: String) -> Data? {
  guard value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { return nil }
  let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
  guard let data = Data(base64Encoded: padded), encoded(data) == value else { return nil }
  return data
}

/** Keys are permanent Keychain items with device-only accessibility and no private-key bridge. */
final class PersonalDeviceStore {
  private let lock = NSLock()
  private func perform<T>(_ work: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    var marker = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent(service + ".installation")
    if !FileManager.default.fileExists(atPath: marker.path) {
      try removeAll()
      try Data(UUID().uuidString.utf8).write(to: marker, options: .atomic)
    }
    var resource = URLResourceValues()
    resource.isExcludedFromBackup = true
    try marker.setResourceValues(resource)
    return try work()
  }
  private func scopeParts(_ scope: String) throws -> [String] {
    let parts = scope.split(separator: ".").map(String.init)
    guard parts.count == 2, parts.allSatisfy({ hex($0) }) else { throw refused() }
    return parts
  }
  private func account(_ scope: String, _ id: String) throws -> String {
    _ = try scopeParts(scope)
    guard uuid(id) else { throw refused() }
    return scope + "." + id
  }
  private func keyQuery(_ scope: String, _ id: String) throws -> [CFString: Any] {
    [
      kSecClass: kSecClassKey,
      kSecAttrApplicationTag: Data((keyPrefix + (try account(scope, id))).utf8),
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass: kSecAttrKeyClassPrivate,
    ]
  }
  private func privateKey(_ scope: String, _ id: String) throws -> SecKey {
    var query = try keyQuery(scope, id)
    query[kSecReturnRef] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let result, CFGetTypeID(result) == SecKeyGetTypeID() else { throw refused() }
    return result as! SecKey
  }
  private func records() throws -> [PersonalRecord] {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword, kSecAttrService: service,
      kSecMatchLimit: kSecMatchLimitAll, kSecReturnData: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = result as? [Data] else { throw refused() }
    return try items.map { bytes in
      guard bytes.count <= 16 * 1024 else { throw refused() }
      let record = try JSONDecoder().decode(PersonalRecord.self, from: bytes)
      _ = try account(record.scope, record.id)
      try record.target.validate()
      guard try scopeParts(record.scope)[1] == record.target.scopeHash() else { throw refused() }
      return record
    }
  }
  private func save(_ record: PersonalRecord) throws {
    let value = try JSONEncoder().encode(record)
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword, kSecAttrService: service,
      kSecAttrAccount: try account(record.scope, record.id),
    ]
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData: value] as CFDictionary)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else { throw refused() }
    var create = query
    create[kSecValueData] = value
    create[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    create[kSecAttrSynchronizable] = false
    guard SecItemAdd(create as CFDictionary, nil) == errSecSuccess else { throw refused() }
  }
  private func remove(_ record: PersonalRecord) throws {
    let keyStatus = SecItemDelete(try keyQuery(record.scope, record.id) as CFDictionary)
    guard keyStatus == errSecSuccess || keyStatus == errSecItemNotFound else { throw refused() }
    let status = SecItemDelete([
      kSecClass: kSecClassGenericPassword, kSecAttrService: service,
      kSecAttrAccount: try account(record.scope, record.id),
    ] as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw refused() }
  }
  private func removeAll() throws { for record in try records() { try remove(record) } }
  func stage(scope: String, target: String) throws -> [String: String] {
    try perform {
      guard target.utf8.count <= 2048 else { throw refused() }
      let parsed = try JSONDecoder().decode(PersonalTarget.self, from: Data(target.utf8))
      try parsed.validate()
      guard try scopeParts(scope)[1] == parsed.scopeHash() else { throw refused() }
      for record in try records() where record.scope == scope && record.descriptor == nil { try remove(record) }
      let id = UUID().uuidString.lowercased()
      let attrs: [CFString: Any] = [
        kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256,
        kSecPrivateKeyAttrs: [
          kSecAttrIsPermanent: true,
          kSecAttrApplicationTag: Data((keyPrefix + (try account(scope, id))).utf8),
          kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
          kSecAttrSynchronizable: false,
        ],
      ]
      var error: Unmanaged<CFError>?
      guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else { throw refused() }
      let der: Data
      do {
        guard let publicKey = SecKeyCopyPublicKey(key),
          let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else { throw refused() }
        der = try P256.Signing.PublicKey(x963Representation: raw).derRepresentation
        try save(PersonalRecord(scope: scope, id: id, target: parsed, descriptor: nil))
      }
      catch {
        SecItemDelete(try keyQuery(scope, id) as CFDictionary)
        throw error
      }
      return ["id": id, "publicKey": encoded(der)]
    }
  }
  func sign(scope: String, id: String, message: String) throws -> String {
    try perform {
      guard message.utf8.count <= 4096,
        let record = try records().first(where: { $0.scope == scope && $0.id == id }),
        let fields = try JSONSerialization.jsonObject(with: Data(message.utf8)) as? [Any],
        let domain = fields.first as? String,
        (domain == "ork-personal-device-activation-v1" && fields.count == 8) ||
          (domain == "ork-personal-device-login-v1" && fields.count == 7) else { throw refused() }
      guard fields[1] as? String == record.target.serverId,
        let version = fields[2] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
        version.doubleValue == Double(record.target.bindingVersion),
        fields[3] as? String == record.target.keyFingerprint,
        fields[4] as? String == record.target.workspaceId,
        fields[5] as? String == record.id,
        let challenge = fields[6] as? String, challenge.count == 43,
        let nonce = decoded(challenge), nonce.count == 32,
        fields.count == 7 || ((fields[7] as? String).map { hex($0) } == true) else { throw refused() }
      var error: Unmanaged<CFError>?
      guard let signature = SecKeyCreateSignature(try privateKey(scope, id), .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error) as Data? else { throw refused() }
      return encoded(signature)
    }
  }
  func activate(scope: String, id: String, descriptor: String) throws {
    try perform {
      guard descriptor.utf8.count <= 8192,
        var record = try records().first(where: { $0.scope == scope && $0.id == id }),
        let json = try JSONSerialization.jsonObject(with: Data(descriptor.utf8)) as? [String: Any],
        Set(json.keys) == Set(["version", "account", "origin", "scope", "deviceId", "target"]),
        let version = json["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
        let owner = json["account"] as? String,
        hash(Data(("ork-personal-account-v1:" + owner).utf8)) == (try scopeParts(scope)[0]),
        json["scope"] as? String == scope, json["deviceId"] as? String == id,
        let origin = json["origin"] as? String, let url = URL(string: origin),
        url.scheme == "https", url.host?.isEmpty == false, url.user == nil, url.password == nil,
        url.query == nil, url.fragment == nil, url.path.isEmpty,
        let rawTarget = json["target"] as? [String: Any],
        Set(rawTarget.keys) == Set(["organizationId", "serverId", "workspaceId", "bindingVersion", "keyFingerprint"]) else { throw refused() }
      let target = try JSONDecoder().decode(PersonalTarget.self, from: JSONSerialization.data(withJSONObject: rawTarget))
      guard target == record.target else { throw refused() }
      _ = try privateKey(scope, id)
      record.descriptor = descriptor
      try save(record)
      for other in try records() where other.scope == scope && other.id != id { try remove(other) }
    }
  }
  func credentials(account: String) throws -> [String] {
    try perform {
      guard hex(account) else { throw refused() }
      return try records().filter { $0.scope.hasPrefix(account + ".") }.compactMap { record in
        guard let descriptor = record.descriptor else { return nil }
        _ = try privateKey(record.scope, record.id)
        return descriptor
      }
    }
  }
  func forget(scope: String, id: String) throws {
    try perform {
      _ = try account(scope, id)
      if let record = try records().first(where: { $0.scope == scope && $0.id == id }) { try remove(record) }
    }
  }
  func forgetAccount(account: String) throws {
    try perform {
      guard hex(account) else { throw refused() }
      for record in try records() where record.scope.hasPrefix(account + ".") { try remove(record) }
    }
  }
  func forgetAll() throws { try perform { try removeAll() } }
  static func verifyServer(publicKey: String, fingerprint: String, message: String, signature: String) -> Bool {
    guard publicKey.count <= 256, signature.count <= 110, message.utf8.count <= 4096,
      hex(fingerprint), let key = decoded(publicKey), hash(key) == fingerprint,
      let bytes = decoded(signature),
      let parsed = try? P256.Signing.PublicKey(derRepresentation: key),
      let proof = try? P256.Signing.ECDSASignature(derRepresentation: bytes) else { return false }
    return parsed.isValidSignature(proof, for: Data(message.utf8))
  }
}
