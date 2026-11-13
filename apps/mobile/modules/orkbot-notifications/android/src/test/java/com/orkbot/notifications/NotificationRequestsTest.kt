// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

package com.orkbot.notifications

import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class NotificationRequestsTest {
  private val endpoint = "https://a0000000-0000-4000-8000-000000000001.installation.ork.invalid"
  private val owner = UUID.randomUUID().toString()
  private var dispatcher: String? = null
  @After fun cleanup() { dispatcher?.let { NotificationRequests.uninstall(it) }; NotificationRequests.clear() }

  @Test fun `virtual installation RPC never falls back to DNS or a raw HTTP client`() {
    dispatcher = NotificationRequests.install { request ->
      assertEquals(setOf("id", "scope", "procedure", "input"), request.keys)
      assertEquals(owner, request["scope"])
      assertEquals("runs/list", request["procedure"])
      assertFalse(request.toString().contains("product-session-fixture"))
      NotificationRequests.reply(request.getValue("id"), owner, 200, "{\"json\":{\"source\":\"pinned\"}}")
    }
    NotificationRequests.configure(owner, endpoint, "product-session-fixture", "space-a")
    assertEquals("pinned", rpc(endpoint, "product-session-fixture", "space-a", "", "runs/list", JSONObject()).getString("source"))
    assertEquals(401, assertThrows(ApiException::class.java) {
      rpc(endpoint, "other-session", "space-a", "", "runs/list", JSONObject())
    }.status)
    assertEquals(401, assertThrows(ApiException::class.java) {
      rpc(endpoint, "product-session-fixture", "space-b", "", "runs/list", JSONObject())
    }.status)
  }

  @Test fun `a service restarted without the live app has no cached transport authority`() {
    NotificationRequests.clear()
    assertEquals(401, assertThrows(ApiException::class.java) {
      rpc(endpoint, "persisted-product-session", "space-a", "", "runs/list", JSONObject())
    }.status)
  }

  @Test fun `replacing a workspace cancels its pending response and refuses late delivery`() {
    val dispatched = CountDownLatch(1)
    var request: Map<String, String> = emptyMap()
    dispatcher = NotificationRequests.install { request = it; dispatched.countDown() }
    NotificationRequests.configure(owner, endpoint, "product-session-fixture", "space-a")
    val executor = Executors.newSingleThreadExecutor()
    try {
      val pending = executor.submit<NotificationResponse> {
        NotificationRequests.request(endpoint, "product-session-fixture", "space-a", "me", "{}")
      }
      assertTrue(dispatched.await(3, TimeUnit.SECONDS))
      NotificationRequests.configure(owner, endpoint, "new-product-session", "space-b")
      NotificationRequests.reply(request.getValue("id"), owner, 200, "private-old-workspace")
      val failure = assertThrows(ExecutionException::class.java) { pending.get(3, TimeUnit.SECONDS) }
      assertEquals(401, (failure.cause as ApiException).status)
    } finally { executor.shutdownNow() }
  }

  @Test fun `a response needs the pending owner and stays within its byte limit`() {
    dispatcher = NotificationRequests.install { request ->
      NotificationRequests.reply(request.getValue("id"), UUID.randomUUID().toString(), 200, "wrong-owner")
      assertThrows(IllegalArgumentException::class.java) {
        NotificationRequests.reply(request.getValue("id"), owner, 200, "é".repeat(MAX_NOTIFICATION_RESPONSE_BYTES / 2 + 1))
      }
      NotificationRequests.reply(request.getValue("id"), owner, 403, "")
    }
    NotificationRequests.configure(owner, endpoint, "product-session-fixture", "space-a")
    assertEquals(403, assertThrows(ApiException::class.java) {
      rpc(endpoint, "product-session-fixture", "space-a", "", "me", JSONObject())
    }.status)
  }

  @Test fun `only canonical virtual origins and the closed background procedure set are accepted`() {
    assertTrue(isInstallationNotificationEndpoint(endpoint))
    assertTrue(isAllowedNotificationEndpoint(endpoint))
    for (invalid in listOf("$endpoint/", "$endpoint:443", "$endpoint?query=1", "$endpoint#fragment", endpoint.uppercase(), endpoint.replace(".invalid", ".invalid."), endpoint.replace("https://", "https://user@"))) {
      assertFalse(invalid, isInstallationNotificationEndpoint(invalid))
      assertFalse(invalid, isAllowedNotificationEndpoint(invalid))
    }
    assertThrows(IllegalArgumentException::class.java) {
      NotificationRequests.request(endpoint, "product-session-fixture", "space-a", "models/delete", "{}")
    }
  }
}
