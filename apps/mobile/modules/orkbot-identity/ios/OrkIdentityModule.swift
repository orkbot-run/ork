// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import ExpoModulesCore

public final class OrkIdentityModule: Module {
  private let store = PersonalDeviceStore()
  public func definition() -> ModuleDefinition {
    Name("OrkIdentity")
    AsyncFunction("stagePersonalKey") { (scope: String, target: String) in
      try self.store.stage(scope: scope, target: target)
    }
    AsyncFunction("signPersonalProof") { (scope: String, id: String, message: String) in
      try self.store.sign(scope: scope, id: id, message: message)
    }
    AsyncFunction("activatePersonalKey") { (scope: String, id: String, descriptor: String) in
      try self.store.activate(scope: scope, id: id, descriptor: descriptor)
    }
    AsyncFunction("personalCredentials") { (account: String) in
      try self.store.credentials(account: account)
    }
    AsyncFunction("forgetPersonalKey") { (scope: String, id: String) in
      try self.store.forget(scope: scope, id: id)
    }
    AsyncFunction("forgetPersonalAccount") { (account: String) in
      try self.store.forgetAccount(account: account)
    }
    AsyncFunction("forgetAllPersonalKeys") { try self.store.forgetAll() }
    AsyncFunction("verifyPersonalServer") { (publicKey: String, fingerprint: String, message: String, signature: String) in
      PersonalDeviceStore.verifyServer(publicKey: publicKey, fingerprint: fingerprint, message: message, signature: signature)
    }
  }
}
