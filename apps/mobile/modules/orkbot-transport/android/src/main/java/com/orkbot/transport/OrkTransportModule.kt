// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

package com.orkbot.transport

import android.content.Context
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrkTransportModule : Module() {
  private val contexts = InstallationContexts()
  private external fun initPlatformVerifier(context: Context)

  private fun initialize() {
    System.loadLibrary("ork_installation_transport")
    initPlatformVerifier(requireNotNull(appContext.reactContext).applicationContext)
  }

  override fun definition() = ModuleDefinition {
    Name("OrkTransport")
    AsyncFunction("start") Coroutine { session: String, revision: Double, id: String -> contexts.start(session, revision, id) }
    AsyncFunction("begin") { initialize(); contexts.begin() }
    AsyncFunction("select") { session: String, revision: Double, target: String -> contexts.select(session, revision, target) }
    AsyncFunction("open") Coroutine { session: String, revision: Double, id: String, input: String -> contexts.open(session, revision, id, input) }
    AsyncFunction("write") Coroutine { session: String, revision: Double, id: String, bytes: String -> contexts.write(session, revision, id, bytes) }
    AsyncFunction("finish") Coroutine { session: String, revision: Double, id: String -> contexts.finish(session, revision, id) }
    AsyncFunction("head") Coroutine { session: String, revision: Double, id: String -> contexts.head(session, revision, id) }
    AsyncFunction("read") Coroutine { session: String, revision: Double, id: String -> contexts.read(session, revision, id) }
    AsyncFunction("cancel") { session: String, revision: Double, id: String -> contexts.cancel(session, revision, id) }
    AsyncFunction("end") { session: String -> contexts.end(session) }
    OnDestroy { contexts.begin() }
  }
}
