// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { MessagingLinkedIdentity, MessagingStatus } from "@orkbot/contracts";
import { createMessagingDeliveryReview } from "@orkbot/core";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Modal, ScrollView, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { captureSettingsContext } from "../lib/settings-target";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

type Source = { isCurrent: () => boolean };

export function MessagingDeliveryReview({
  identity,
  review,
  owner,
  onStatus,
}: {
  identity: MessagingLinkedIdentity;
  review: NonNullable<MessagingLinkedIdentity["deliveryReview"]>;
  owner: Source;
  onStatus: (status: MessagingStatus) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const live = useRef(false);
  const latest = useRef({ identity, review, owner, onStatus });
  latest.current = { identity, review, owner, onStatus };
  const origin = useMemo(
    () => captureSettingsContext({ scope: "space", spaceId: review.spaceId }),
    [owner, identity.id, identity.botId, identity.address, identity.provider, review.spaceId],
  );
  const owned = () =>
    owner.isCurrent() &&
    origin.isCurrent() &&
    latest.current.owner === owner &&
    latest.current.identity.id === identity.id &&
    latest.current.identity.botId === identity.botId &&
    latest.current.identity.address === identity.address &&
    latest.current.identity.provider === identity.provider &&
    latest.current.review.spaceId === review.spaceId;
  const current = () => live.current && owned();
  const controller = useMemo(
    () =>
      createMessagingDeliveryReview({
        isCurrent: current,
        list: () => origin.send("messaging/outbound/list", { identityId: identity.id }),
        resolve: (item, resolution) =>
          origin.send("messaging/outbound/resolve", {
            identityId: identity.id,
            outboundId: item.id,
            version: item.version,
            resolution,
          }),
        refreshContext: async () => {
          const next = await origin.send("messaging/status");
          if (current()) latest.current.onStatus(next);
        },
      }),
    [origin],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      controller.close();
    };
  }, [controller]);
  const item = state.items[0];
  return (
    <View>
      <NativeActionButton
        label={t("Review delivery")}
        size="compact"
        prominence="quiet"
        variant="text"
        fill={false}
        busy={state.pending}
        disabled={!owned()}
        onPress={() => void controller.load()}
      />
      {state.opened && owned() ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={controller.close}
        >
          <View
            accessibilityViewIsModal
            accessibilityLabel={t("Review delivery")}
            style={{ flex: 1, backgroundColor: tokens.background, padding: 16, gap: 16 }}
          >
            <NativeActionButton
              label={t("Cancel")}
              prominence="plain"
              fill={false}
              onPress={controller.close}
            />
            <ScrollView
              contentInsetAdjustmentBehavior="automatic"
              contentContainerStyle={{ gap: 16 }}
            >
              <Text style={{ color: tokens.foreground }}>{identity.botName}</Text>
              <Text style={{ color: tokens.mutedForeground }}>{identity.address}</Text>
              {item ? (
                <>
                  <Text style={{ color: tokens.mutedForeground }}>
                    {t(
                      "Check the chat first. Marking the result resumes queued messages without resending this message.",
                    )}
                  </Text>
                  <Text selectable style={{ color: tokens.foreground }}>
                    {item.preview}
                  </Text>
                  {item.attachmentName ? (
                    <Text style={{ color: tokens.mutedForeground }}>{item.attachmentName}</Text>
                  ) : null}
                  <NativeActionButton
                    label={t("Mark as sent")}
                    disabled={Boolean(state.error) || !owned()}
                    busy={state.pending}
                    onPress={() => void controller.resolve(item, "confirmed_sent")}
                  />
                  <NativeActionButton
                    label={t("Mark as not sent")}
                    disabled={Boolean(state.error) || !owned()}
                    busy={state.pending}
                    prominence="quiet"
                    onPress={() => void controller.resolve(item, "confirmed_not_sent")}
                  />
                </>
              ) : null}
              {state.error ? (
                <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
                  {errorText(state.error, t("Could not save"))}
                </Text>
              ) : null}
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}
