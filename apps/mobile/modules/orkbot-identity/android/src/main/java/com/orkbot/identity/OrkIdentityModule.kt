// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

package com.orkbot.identity

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrkIdentityModule : Module() {
  private val store by lazy {
    PersonalDeviceStore(appContext.reactContext ?: throw IllegalStateException("Personal device credential unavailable"))
  }
  override fun definition() = ModuleDefinition {
    Name("OrkIdentity")
    AsyncFunction("stagePersonalKey") { scope: String, target: String -> store.stage(scope, target) }
    AsyncFunction("signPersonalProof") { scope: String, id: String, message: String -> store.sign(scope, id, message) }
    AsyncFunction("activatePersonalKey") { scope: String, id: String, descriptor: String -> store.activate(scope, id, descriptor) }
    AsyncFunction("personalCredentials") { account: String -> store.credentials(account) }
    AsyncFunction("forgetPersonalKey") { scope: String, id: String -> store.forget(scope, id) }
    AsyncFunction("forgetPersonalAccount") { account: String -> store.forgetAccount(account) }
    AsyncFunction("forgetAllPersonalKeys") { store.forgetAll() }
    AsyncFunction("verifyPersonalServer") { publicKey: String, fingerprint: String, message: String, signature: String ->
      PersonalDeviceStore.verifyServer(publicKey, fingerprint, message, signature)
    }
  }
}
