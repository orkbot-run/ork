// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

package com.orkbot.transport

import android.util.Base64
import java.net.URI
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import uniffi.ork_installation_transport.HttpHeader
import uniffi.ork_installation_transport.HttpRequest
import uniffi.ork_installation_transport.InstallationConnection
import uniffi.ork_installation_transport.RelayRoute

internal data class InstallationSelection(
  val account: String,
  val origin: String,
  val organizationId: String,
  val serverId: String,
  val workspaceId: String,
  val bindingVersion: ULong,
  val keyFingerprint: String,
  val relayOrigin: String?,
) {
  fun connection(ticket: String?) : InstallationConnection {
    if (relayOrigin == null) {
      require(ticket == null)
      return InstallationConnection(origin, serverId, bindingVersion, keyFingerprint)
    }
    return InstallationConnection.viaRelay(origin, serverId, bindingVersion, keyFingerprint,
      RelayRoute(relayOrigin, requireNotNull(ticket), organizationId, workspaceId))
  }
}

/** Never hold the context lock while a request waits for network input or backpressure. */
internal class InstallationContexts {
  private val gate = Any()
  private var session = UUID.randomUUID().toString()
  private var revision = 0L
  private var selection: InstallationSelection? = null
  private val requests = mutableMapOf<String, InstallationConnection>()
  private val inputs = mutableMapOf<String, HttpRequest>()

  fun begin(): String = synchronized(gate) {
    requests.values.forEach { it.cancel() }
    requests.clear()
    inputs.clear()
    selection = null
    revision = 0
    session = UUID.randomUUID().toString()
    session
  }

  fun end(expected: String) = synchronized(gate) { if (session == expected) begin(); Unit }

  fun select(expected: String, version: Double, target: String) = synchronized(gate) {
    val next = revision(version)
    require(session == expected && next >= revision && target.toByteArray().size <= 8192)
    val json = JSONObject(target)
    val account = json.getString("account")
    val owner = JSONArray(account)
    require(owner.length() == 2)
    for (index in 0..1) require(owner.get(index) is String && owner.getString(index).isNotEmpty() && owner.getString(index).toByteArray().size <= 2048)
    val issuer = URI(owner.getString(0))
    require(issuer.scheme == "https" && issuer.host != null && issuer.rawUserInfo == null && issuer.rawQuery == null && issuer.rawFragment == null)
    val origin = URI(json.getString("origin"))
    require(!(origin.scheme == "https" && origin.host.equals(issuer.host, true) && (if (origin.port == -1) 443 else origin.port) == (if (issuer.port == -1) 443 else issuer.port)))
    val relayOrigin = if (json.has("relayOrigin")) json.getString("relayOrigin") else null
    val selected = InstallationSelection(account, origin.toString(), uuid(json.getString("organizationId")), uuid(json.getString("serverId")), uuid(json.getString("workspaceId")), revision(json.getDouble("bindingVersion")).toULong(), json.getString("keyFingerprint"), relayOrigin)
    InstallationConnection(selected.origin, selected.serverId, selected.bindingVersion, selected.keyFingerprint).use { it.cancel() }
    if (relayOrigin != null) {
      val relay = URI(relayOrigin)
      require(relay.scheme == "https" && relay.host != null && relay.rawUserInfo == null && relay.rawQuery == null && relay.rawFragment == null && relay.rawPath.isNullOrEmpty())
      require(!(relay.host.equals(issuer.host, true) && (if (relay.port == -1) 443 else relay.port) == (if (issuer.port == -1) 443 else issuer.port)))
      require(relayOrigin != selected.origin && selected.origin == "https://${selected.serverId}.installation.ork.invalid")
    }
    if (next == revision) require(selected == selection)
    else {
      requests.values.forEach { it.cancel() }
      requests.clear()
      inputs.clear()
      selection = selected
      revision = next
    }
  }

  suspend fun open(expected: String, version: Double, id: String, input: String) {
    require(input.toByteArray().size <= 64 * 1024)
    val json = JSONObject(input)
    val headers = json.getJSONArray("headers")
    val request = HttpRequest(json.getString("method"), json.getString("path"), (0 until headers.length()).map {
      val header = headers.getJSONObject(it)
      HttpHeader(header.getString("name"), header.getString("value"))
    }, json.getBoolean("hasBody"))
    synchronized(gate) {
      current(expected, version)
      require(uuid(id) == id && !requests.containsKey(id))
      requests[id] = requireNotNull(selection).connection(if (json.has("relayTicket")) json.getString("relayTicket") else null)
      inputs[id] = request
    }
  }

  suspend fun start(expected: String, version: Double, id: String) {
    val request = synchronized(gate) { current(expected, version); requireNotNull(inputs.remove(id)) }
    perform(expected, version, id) { it.startRequest(request) }
  }

  suspend fun write(expected: String, version: Double, id: String, encoded: String): Boolean {
    require(encoded.toByteArray().size <= 88 * 1024)
    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
    require(bytes.size <= 64 * 1024)
    return perform(expected, version, id) { it.writeBody(bytes) }
  }

  suspend fun finish(expected: String, version: Double, id: String) = perform(expected, version, id) { it.finishBody() }
  suspend fun head(expected: String, version: Double, id: String): Map<String, Any> = perform(expected, version, id) {
    val head = it.responseHead()
    mapOf("status" to head.status.toInt(), "headers" to head.headers.map { header -> mapOf("name" to header.name, "value" to header.value) })
  }

  suspend fun read(expected: String, version: Double, id: String): String? {
    val bytes = perform(expected, version, id) { it.readBody() }
    if (bytes == null) cancel(expected, version, id)
    return bytes?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
  }

  fun cancel(expected: String, version: Double, id: String) = synchronized(gate) {
    if (session == expected && revision.toDouble() == version) {
      inputs.remove(id)
      requests.remove(id)?.cancel()
    }
    Unit
  }

  private fun current(expected: String, version: Double) {
    require(session == expected && revision == revision(version) && selection != null)
  }

  private suspend fun <T> perform(expected: String, version: Double, id: String, action: suspend (InstallationConnection) -> T): T {
    val operation = synchronized(gate) { current(expected, version); requireNotNull(requests[id]) }
    try {
      val result = action(operation)
      synchronized(gate) { current(expected, version); require(requests[id] === operation) }
      return result
    } catch (error: Throwable) {
      synchronized(gate) { if (requests[id] === operation) { requests.remove(id); inputs.remove(id) } }
      operation.cancel()
      throw error
    }
  }

  private fun uuid(value: String): String {
    require(UUID.fromString(value).toString() == value)
    return value
  }

  private fun revision(value: Double): Long {
    require(value.isFinite() && value >= 1 && value <= 9007199254740991.0 && value.toLong().toDouble() == value)
    return value.toLong()
  }
}
