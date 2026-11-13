// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

package com.orkbot.notifications

import java.io.IOException
import java.net.URI
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal const val MAX_NOTIFICATION_RESPONSE_BYTES = 16 * 1024 * 1024
internal data class NotificationResponse(val status: Int, val body: String)

/** The live app owns pinned transport and ticket renewal; a restarted service has no authority. */
internal object NotificationRequests {
  private data class Owner(val id: String, val endpoint: String, val token: String, val space: String)
  private data class Pending(val owner: Owner, val result: CompletableFuture<NotificationResponse>)
  private val gate = Any()
  private var dispatcher: Pair<String, (Map<String, String>) -> Unit>? = null
  private val owners = linkedMapOf<String, Owner>()
  private val pending = mutableMapOf<String, Pending>()
  private val procedures = setOf("me", "runs/list", "threads/get", "notifications/declineIncomingCall")

  fun install(send: (Map<String, String>) -> Unit): String = synchronized(gate) {
    clear()
    UUID.randomUUID().toString().also { dispatcher = it to send }
  }

  fun uninstall(id: String) = synchronized(gate) {
    if (dispatcher?.first == id) {
      dispatcher = null
      clear()
    }
  }

  fun configure(id: String, endpoint: String, token: String, space: String) = synchronized(gate) {
    require(UUID.fromString(id).toString() == id && isInstallationNotificationEndpoint(endpoint))
    require(token.isNotBlank() && token.length <= 64 * 1024 && space.length <= 2048)
    val next = Owner(id, endpoint, token, space)
    if (owners[id] == next) return@synchronized
    val retired = owners.values.filter { it.endpoint == endpoint && it.space == space }.map { it.id }.toMutableSet()
    if (owners.containsKey(id)) retired += id
    if (owners.size >= 4) retired += owners.keys.first()
    retired.forEach { retire(it) }
    owners[id] = next
  }

  fun clear() = synchronized(gate) {
    owners.clear()
    pending.values.forEach { it.result.completeExceptionally(ApiException(401)) }
    pending.clear()
  }

  fun reply(id: String, scope: String, status: Int, body: String) = synchronized(gate) {
    val request = pending[id] ?: return@synchronized
    if (request.owner.id != scope || owners[scope] != request.owner) return@synchronized
    require(status in 200..599 && body.toByteArray(Charsets.UTF_8).size <= MAX_NOTIFICATION_RESPONSE_BYTES)
    request.result.complete(NotificationResponse(status, body))
  }

  fun request(endpoint: String, token: String, space: String, procedure: String, input: String): NotificationResponse {
    require(procedure in procedures && input.toByteArray(Charsets.UTF_8).size <= 64 * 1024)
    val id = UUID.randomUUID().toString()
    val (request, send) = synchronized(gate) {
      val owner = owners.values.find { it.endpoint == endpoint && it.token == token && it.space == space }
        ?: throw ApiException(401)
      val send = dispatcher?.second ?: throw ApiException(401)
      if (pending.size >= 8) throw IOException("Notification requests are busy")
      val request = Pending(owner, CompletableFuture())
      pending[id] = request
      request to send
    }
    try {
      send(mapOf("id" to id, "scope" to request.owner.id, "procedure" to procedure, "input" to input))
      val response = request.result.get(8, TimeUnit.SECONDS)
      synchronized(gate) {
        if (owners[request.owner.id] != request.owner) throw ApiException(401)
      }
      return response
    } catch (error: ExecutionException) {
      throw (error.cause as? ApiException ?: IOException("Notification request failed"))
    } catch (_: TimeoutException) {
      throw IOException("Notification request timed out")
    } finally {
      synchronized(gate) { pending.remove(id) }
    }
  }

  private fun retire(id: String) {
    owners.remove(id)
    pending.values.filter { it.owner.id == id }.forEach { it.result.completeExceptionally(ApiException(401)) }
  }
}

internal fun isInstallationNotificationEndpoint(endpoint: String): Boolean {
  val uri = runCatching { URI(endpoint) }.getOrNull() ?: return false
  val host = uri.host ?: return false
  if (uri.scheme != "https" || uri.rawUserInfo != null || uri.port != -1 ||
    !uri.rawPath.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null) return false
  val suffix = ".installation.ork.invalid"
  if (!host.endsWith(suffix)) return false
  val server = host.removeSuffix(suffix)
  return runCatching { UUID.fromString(server).toString() == server }.getOrDefault(false)
}
