// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; unused helper removal and session-bound push registration are Ork changes.

import { newClientId } from "@orkbot/core";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, currentApiBase, rpc } from "./api";
import {
  configureNotificationSessionWriter,
  setNotificationSessionScope,
} from "./notification-session";
import type { NativeNotificationTransport } from "./notification-transport";
import { prepareNotificationTransport } from "./notification-transport";
import { serverHeaders } from "./server-headers";
import { currentSessionGeneration } from "./session";

const notificationModule = requireOptionalNativeModule<
  Partial<NativeNotificationTransport> & {
    configureMessageSession?: (scope: string) => Promise<void>;
    configureIncomingSession?: (endpoint: string, headers: Record<string, string>) => Promise<void>;
  }
>("OrkNotifications");
configureNotificationSessionWriter(async (scope) => {
  await notificationModule?.configureMessageSession?.(scope);
});

async function notificationsAllowed() {
  // On iOS getPermissionsAsync holds Expo's shared native queue until the system answers,
  // which can take minutes after a restart, and SecureStore waits behind it. The request
  // does not hold the queue and only prompts while the user hasn't chosen yet.
  if (Platform.OS === "ios") return (await Notifications.requestPermissionsAsync()).granted;
  const existing = await Notifications.getPermissionsAsync();
  return existing.granted || (await Notifications.requestPermissionsAsync()).granted;
}

export async function registerPushToken() {
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return;
  try {
    const owner = await captureApiRequestContext(null);
    if (!owner.headers.authorization) return;
    if (!(await notificationsAllowed())) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token) return;
    const registered = await rpc(
      "notifications/registerPush",
      {
        token,
        ...(Platform.OS === "android" &&
        requireOptionalNativeModule<{ supportsSenderAvatars?: boolean }>("OrkNotifications")
          ?.supportsSenderAvatars
          ? { presentation: "android_sender" as const }
          : {}),
      },
      { requestContext: owner },
    );
    const current = () =>
      owner.sessionGeneration === currentSessionGeneration() && owner.apiBase === currentApiBase();
    if (current() && notificationModule?.configureIncomingSession)
      await prepareNotificationTransport(
        notificationModule,
        owner.apiBase,
        owner.headers.authorization.replace(/^Bearer /, ""),
        "",
      );
    if (current())
      await notificationModule?.configureIncomingSession?.(owner.apiBase, {
        ...serverHeaders(owner.apiBase),
        ...owner.headers,
      });
    await setNotificationSessionScope(registered.sessionScope, current);
    await registerCallPushToken({ expoToken: token }, owner);
  } catch {
    // Expo Go without an EAS project id and Android builds without a Firebase config
    // cannot mint an Expo push token.
  }
}

let callTokens: { expoToken?: string; voipToken?: string } = {};
let tokenGeneration = -1;
let registeredKey: string | undefined;
let deviceIdPromise: Promise<string> | undefined;
async function installationId() {
  deviceIdPromise ??= (async () => {
    const stored = await SecureStore.getItemAsync("orkbot.call-device");
    if (stored) return stored;
    const id = newClientId();
    await SecureStore.setItemAsync("orkbot.call-device", id);
    return id;
  })();
  const pending = deviceIdPromise;
  try {
    return await pending;
  } catch (error) {
    if (deviceIdPromise === pending) deviceIdPromise = undefined;
    throw error;
  }
}
/** Builds without native call handling keep the account's ordinary push for incoming calls. */
const nativeCalls = Boolean(
  requireOptionalNativeModule<{ incomingState?: unknown }>("OrkNotifications")?.incomingState,
);

export async function registerCallPushToken(
  tokens: { expoToken?: string; voipToken?: string },
  requestContext?: ApiRequestContext,
) {
  if (!nativeCalls) return;
  const owner = requestContext ?? (await captureApiRequestContext(null));
  const generation = owner.sessionGeneration;
  if (!owner.headers.authorization || generation !== currentSessionGeneration()) return;
  if (generation !== tokenGeneration) {
    callTokens = {};
    registeredKey = undefined;
    tokenGeneration = generation;
  }
  const registration = { ...callTokens, ...tokens };
  const key = JSON.stringify(registration);
  if (key === registeredKey) return;
  callTokens = registration;
  const deviceId = await installationId();
  if (generation !== currentSessionGeneration()) return;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;
  await rpc(
    "notifications/registerCallPush",
    { deviceId, platform: Platform.OS, ...registration },
    { requestContext: owner },
  );
  if (generation === currentSessionGeneration()) registeredKey = key;
}
