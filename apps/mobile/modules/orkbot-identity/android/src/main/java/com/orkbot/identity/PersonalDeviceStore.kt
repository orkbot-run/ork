// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

package com.orkbot.identity

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

private const val FAILURE = "Personal device credential unavailable"
private const val PREFIX = "run.orkbot.personal-key.v1."
private val HEX = Regex("^[a-f0-9]{64}$")
private val UUID_PATTERN = Regex("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
private fun requireCredential(value: Boolean) { if (!value) throw IllegalStateException(FAILURE) }
private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
private fun encoded(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
private fun decoded(value: String): ByteArray {
  requireCredential(value.matches(Regex("^[A-Za-z0-9_-]+$")))
  val bytes = Base64.decode(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  requireCredential(encoded(bytes) == value)
  return bytes
}
private data class Target(val organizationId: String, val serverId: String, val workspaceId: String, val bindingVersion: Long, val keyFingerprint: String) {
  fun hash(): String = hash(JSONArray().put("ork-personal-target-v1").put(organizationId).put(serverId).put(workspaceId).put(bindingVersion).put(keyFingerprint).toString().toByteArray(Charsets.UTF_8))
  fun json(): JSONObject = JSONObject().put("organizationId", organizationId).put("serverId", serverId).put("workspaceId", workspaceId).put("bindingVersion", bindingVersion).put("keyFingerprint", keyFingerprint)
  companion object {
    fun parse(json: JSONObject): Target {
      val version = json.get("bindingVersion")
      requireCredential(version is Number && version.toDouble() > 0 && version.toDouble() <= 9_007_199_254_740_991.0 && version.toDouble() == version.toLong().toDouble())
      val target = Target(json.getString("organizationId"), json.getString("serverId"), json.getString("workspaceId"), (version as Number).toLong(), json.getString("keyFingerprint"))
      requireCredential(listOf(target.organizationId, target.serverId, target.workspaceId).all { UUID_PATTERN.matches(it) } && HEX.matches(target.keyFingerprint))
      return target
    }
  }
}
private data class Record(val scope: String, val id: String, val target: Target, val descriptor: String?) {
  fun name(): String = scope + "." + id
  fun json(): String = JSONObject().put("scope", scope).put("id", id).put("target", target.json()).put("descriptor", descriptor ?: JSONObject.NULL).toString()
}

/** AndroidKeyStore private keys remain inside this application's device keystore. */
internal class PersonalDeviceStore(context: Context) {
  private val lock = Any()
  private val preferences = context.getSharedPreferences("ork-personal-device-v1", Context.MODE_PRIVATE)
  private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private fun parts(scope: String): List<String> {
    val values = scope.split(".")
    requireCredential(values.size == 2 && values.all { HEX.matches(it) })
    return values
  }
  private fun name(scope: String, id: String): String {
    parts(scope)
    requireCredential(UUID_PATTERN.matches(id))
    return scope + "." + id
  }
  private fun records(): List<Record> = preferences.all.map { (name, value) ->
    requireCredential(value is String && value.length <= 16 * 1024)
    val json = JSONObject(value as String)
    val record = Record(json.getString("scope"), json.getString("id"), Target.parse(json.getJSONObject("target")), if (json.isNull("descriptor")) null else json.getString("descriptor"))
    requireCredential(this.name(record.scope, record.id) == name && parts(record.scope)[1] == record.target.hash())
    record
  }
  private fun privateKey(record: Record): PrivateKey {
    return keys.getKey(PREFIX + record.name(), null) as? PrivateKey ?: throw IllegalStateException(FAILURE)
  }
  private fun remove(record: Record) {
    keys.deleteEntry(PREFIX + record.name())
    requireCredential(preferences.edit().remove(record.name()).commit())
  }
  fun stage(scope: String, rawTarget: String): Map<String, String> = synchronized(lock) {
    requireCredential(rawTarget.length <= 2048)
    val target = Target.parse(JSONObject(rawTarget))
    requireCredential(parts(scope)[1] == target.hash())
    records().filter { it.scope == scope && it.descriptor == null }.forEach { remove(it) }
    val record = Record(scope, UUID.randomUUID().toString(), target, null)
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    generator.initialize(KeyGenParameterSpec.Builder(PREFIX + record.name(), KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(false)
      .build())
    val pair = generator.generateKeyPair()
    try {
      requireCredential(preferences.edit().putString(record.name(), record.json()).commit())
    } catch (error: Throwable) {
      keys.deleteEntry(PREFIX + record.name())
      throw error
    }
    mapOf("id" to record.id, "publicKey" to encoded(pair.public.encoded))
  }
  fun sign(scope: String, id: String, message: String): String = synchronized(lock) {
    name(scope, id)
    requireCredential(message.toByteArray(Charsets.UTF_8).size <= 4096)
    val record = records().find { it.scope == scope && it.id == id } ?: throw IllegalStateException(FAILURE)
    val fields = JSONArray(message)
    val domain = fields.optString(0)
    requireCredential((domain == "ork-personal-device-activation-v1" && fields.length() == 8) || (domain == "ork-personal-device-login-v1" && fields.length() == 7))
    val version = fields.get(2)
    requireCredential(fields.getString(1) == record.target.serverId && version is Number && version.toDouble() == record.target.bindingVersion.toDouble() &&
      fields.getString(3) == record.target.keyFingerprint && fields.getString(4) == record.target.workspaceId && fields.getString(5) == record.id &&
      fields.getString(6).length == 43 && decoded(fields.getString(6)).size == 32)
    if (fields.length() == 8) requireCredential(HEX.matches(fields.getString(7)))
    val signature = Signature.getInstance("SHA256withECDSA")
    signature.initSign(privateKey(record))
    signature.update(message.toByteArray(Charsets.UTF_8))
    encoded(signature.sign())
  }
  fun activate(scope: String, id: String, descriptor: String): Unit = synchronized(lock) {
    name(scope, id)
    requireCredential(descriptor.toByteArray(Charsets.UTF_8).size <= 8192)
    val record = records().find { it.scope == scope && it.id == id } ?: throw IllegalStateException(FAILURE)
    val json = JSONObject(descriptor)
    requireCredential(json.keys().asSequence().toSet() == setOf("version", "account", "origin", "scope", "deviceId", "target") && json.get("version") is Number && json.getDouble("version") == 1.0)
    requireCredential(hash(("ork-personal-account-v1:" + json.getString("account")).toByteArray(Charsets.UTF_8)) == parts(scope)[0])
    requireCredential(json.getString("scope") == scope && json.getString("deviceId") == id && Target.parse(json.getJSONObject("target")) == record.target)
    val origin = URI(json.getString("origin"))
    requireCredential(origin.scheme == "https" && !origin.host.isNullOrEmpty() && origin.rawUserInfo == null && origin.rawQuery == null && origin.rawFragment == null && origin.rawPath.isNullOrEmpty())
    privateKey(record)
    requireCredential(preferences.edit().putString(record.name(), record.copy(descriptor = descriptor).json()).commit())
    records().filter { it.scope == scope && it.id != id }.forEach { remove(it) }
  }
  fun credentials(account: String): List<String> = synchronized(lock) {
    requireCredential(HEX.matches(account))
    records().filter { it.scope.startsWith(account + ".") && it.descriptor != null }.map { record ->
      privateKey(record)
      record.descriptor!!
    }
  }
  fun forget(scope: String, id: String): Unit = synchronized(lock) {
    name(scope, id)
    records().find { it.scope == scope && it.id == id }?.let { remove(it) }
  }
  fun forgetAccount(account: String): Unit = synchronized(lock) {
    requireCredential(HEX.matches(account))
    records().filter { it.scope.startsWith(account + ".") }.forEach { remove(it) }
  }
  fun forgetAll(): Unit = synchronized(lock) { records().forEach { remove(it) } }

  companion object {
    fun verifyServer(publicKey: String, fingerprint: String, message: String, signature: String): Boolean = try {
      requireCredential(publicKey.length <= 256 && signature.length <= 110 && message.toByteArray(Charsets.UTF_8).size <= 4096 && HEX.matches(fingerprint))
      val bytes = decoded(publicKey)
      requireCredential(hash(bytes) == fingerprint)
      val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(bytes)) as? ECPublicKey ?: throw IllegalStateException(FAILURE)
      val parameters = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
      requireCredential(key.params.order == parameters.order && key.params.generator == parameters.generator && key.params.curve == parameters.curve && key.params.cofactor == parameters.cofactor)
      val verifier = Signature.getInstance("SHA256withECDSA")
      verifier.initVerify(key)
      verifier.update(message.toByteArray(Charsets.UTF_8))
      verifier.verify(decoded(signature))
    } catch (_: Throwable) { false }
  }
}
