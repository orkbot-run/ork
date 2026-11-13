// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import CryptoKit
import Foundation
import XCTest

final class PersonalDeviceStoreTests: XCTestCase {
  private let store = PersonalDeviceStore()
  private let account = "[\"https://accounts.example.test\",\"owner\"]"
  private let origin = "https://server.example.test"
  private let organization = "00000000-0000-4000-8000-000000000001"
  private let server = "00000000-0000-4000-8000-000000000002"
  private let workspace = "00000000-0000-4000-8000-000000000003"
  private let fingerprint = String(repeating: "a", count: 64)
  private func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private func json(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
  }
  private func decoded(_ value: String) -> Data {
    Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4))!
  }
  private var ownerHash: String { digest("ork-personal-account-v1:" + account) }
  private var target: [String: Any] {
    ["organizationId": organization, "serverId": server, "workspaceId": workspace, "bindingVersion": 1, "keyFingerprint": fingerprint]
  }
  private func scope() throws -> String {
    ownerHash + "." + digest(try json(["ork-personal-target-v1", organization, server, workspace, 1, fingerprint]))
  }
  private func descriptor(_ key: [String: String]) throws -> String {
    try json(["version": 1, "account": account, "origin": origin, "scope": scope(), "deviceId": key["id"]!, "target": target])
  }
  private func message(_ key: [String: String], activation: Bool = false) throws -> String {
    var fields: [Any] = [activation ? "ork-personal-device-activation-v1" : "ork-personal-device-login-v1", server, 1, fingerprint, workspace, key["id"]!, String(repeating: "c", count: 43)]
    if activation { fields.append(String(repeating: "b", count: 64)) }
    return try json(fields)
  }
  override func setUpWithError() throws { try store.forgetAll() }
  override func tearDownWithError() throws { try store.forgetAll() }

  func testKeychainSignsCanonicalP256ProofsAndSurvivesStoreRecreation() throws {
    let key = try store.stage(scope: scope(), target: json(target))
    let publicKey = try P256.Signing.PublicKey(derRepresentation: decoded(key["publicKey"]!))
    for activation in [true, false] {
      let proof = try message(key, activation: activation)
      let signature = try store.sign(scope: scope(), id: key["id"]!, message: proof)
      XCTAssertTrue(publicKey.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: decoded(signature)), for: Data(proof.utf8)))
    }
    XCTAssertEqual(try store.credentials(account: ownerHash), [])
    let metadata = try descriptor(key)
    try store.activate(scope: scope(), id: key["id"]!, descriptor: metadata)
    XCTAssertEqual(try PersonalDeviceStore().credentials(account: ownerHash), [metadata])
    XCTAssertEqual(Set(key.keys), Set(["id", "publicKey"]))
  }
  func testRejectsSubstitutedScopeAccountTargetAndUnrelatedSigningMessages() throws {
    let key = try store.stage(scope: scope(), target: json(target))
    let proof = try message(key)
    for changed in [proof.replacingOccurrences(of: server, with: organization), proof.replacingOccurrences(of: workspace, with: organization),
      proof.replacingOccurrences(of: "login-v1", with: "other-v1"), proof.replacingOccurrences(of: ",1,", with: ",true,") ] {
      XCTAssertThrowsError(try store.sign(scope: scope(), id: key["id"]!, message: changed))
    }
    let metadata = try descriptor(key)
    for changed in [metadata.replacingOccurrences(of: "owner", with: "another"), metadata.replacingOccurrences(of: origin, with: "http://server.example.test"),
      metadata.replacingOccurrences(of: workspace, with: organization)] {
      XCTAssertThrowsError(try store.activate(scope: scope(), id: key["id"]!, descriptor: changed))
    }
    XCTAssertThrowsError(try store.stage(scope: String(repeating: "b", count: 64) + "." + String(repeating: "c", count: 64), target: json(target)))
  }
  func testFailedStagingDoesNotReplaceAnActivatedCredential() throws {
    let key = try store.stage(scope: scope(), target: json(target))
    let metadata = try descriptor(key)
    try store.activate(scope: scope(), id: key["id"]!, descriptor: metadata)
    let pending = try store.stage(scope: scope(), target: json(target))
    try store.forget(scope: scope(), id: pending["id"]!)
    XCTAssertEqual(try store.credentials(account: ownerHash), [metadata])
    XCTAssertNoThrow(try store.sign(scope: scope(), id: key["id"]!, message: message(key)))
  }
  func testLogoutDeletesPrivateKeyAndPublicMetadataAcrossStoreRecreation() throws {
    let key = try store.stage(scope: scope(), target: json(target))
    try store.activate(scope: scope(), id: key["id"]!, descriptor: descriptor(key))
    try store.forgetAll()
    let reloaded = PersonalDeviceStore()
    XCTAssertEqual(try reloaded.credentials(account: ownerHash), [])
    XCTAssertThrowsError(try reloaded.sign(scope: scope(), id: key["id"]!, message: message(key)))
  }
  func testReinstallationMarkerIsExcludedFromBackupAndLosingItRetiresOldKeys() throws {
    let key = try store.stage(scope: scope(), target: json(target))
    try store.activate(scope: scope(), id: key["id"]!, descriptor: descriptor(key))
    let marker = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent("run.orkbot.personal-device.v1.installation")
    XCTAssertEqual(try marker.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    try FileManager.default.removeItem(at: marker)
    XCTAssertEqual(try PersonalDeviceStore().credentials(account: ownerHash), [])
  }
  func testPinnedInstallationProofRejectsWrongKeysMessagesAndSignatures() throws {
    let key = P256.Signing.PrivateKey()
    let bytes = key.publicKey.derRepresentation
    let fingerprint = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    func encode(_ bytes: Data) -> String { bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    let proof = "installation proof"
    let signature = try key.signature(for: Data(proof.utf8))
    XCTAssertTrue(PersonalDeviceStore.verifyServer(publicKey: encode(bytes), fingerprint: fingerprint, message: proof, signature: encode(signature.derRepresentation)))
    XCTAssertFalse(PersonalDeviceStore.verifyServer(publicKey: encode(bytes), fingerprint: fingerprint, message: "changed", signature: encode(signature.derRepresentation)))
    XCTAssertFalse(PersonalDeviceStore.verifyServer(publicKey: encode(bytes), fingerprint: String(repeating: "0", count: 64), message: proof, signature: encode(signature.derRepresentation)))
  }
}
