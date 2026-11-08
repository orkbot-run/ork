// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { MessagingLinkedIdentity } from "@orkbot/contracts";
import { createMessagingDeliveryReview } from "@orkbot/core";
import { writeSaved } from "@orkbot/core/query";
import { Button } from "@orkbot/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { authClient } from "../lib/auth";
import { useQueryUserId, useSpaceQueries } from "../lib/query";
import { captureRpcContext } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function MessagingDeliveryReview({
  identity,
  review,
}: {
  identity: MessagingLinkedIdentity;
  review: NonNullable<MessagingLinkedIdentity["deliveryReview"]>;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryUserId = useQueryUserId();
  const session = authClient.useSession();
  const sessionId = session.data?.session?.id;
  const userId = session.data?.user?.id;
  const cache = useQueryClient();
  const live = useRef(false);
  const latest = useRef({ identity, review, userId, queryUserId, sessionId });
  latest.current = { identity, review, userId, queryUserId, sessionId };
  const origin = useMemo(
    () => captureRpcContext(review.spaceId),
    [
      queries,
      sessionId,
      userId,
      queryUserId,
      identity.id,
      identity.botId,
      identity.address,
      identity.provider,
      review.spaceId,
    ],
  );
  const [verifiedOrigin, setVerifiedOrigin] = useState(origin);
  const verified = useRef(verifiedOrigin);
  verified.current = verifiedOrigin;
  const [renewalError, setRenewalError] = useState<unknown>(null);
  const sourceCurrent = () =>
    Boolean(userId) &&
    userId === queryUserId &&
    latest.current.userId === userId &&
    latest.current.queryUserId === queryUserId &&
    latest.current.sessionId === sessionId &&
    origin.isCurrent() &&
    latest.current.identity.id === identity.id &&
    latest.current.identity.botId === identity.botId &&
    latest.current.identity.address === identity.address &&
    latest.current.identity.provider === identity.provider &&
    latest.current.review.spaceId === review.spaceId;
  const owned = () => verified.current === origin && sourceCurrent();
  const current = () => live.current && owned();
  const controller = useMemo(
    () =>
      createMessagingDeliveryReview({
        isCurrent: current,
        list: () => origin.client.messaging.outbound.list({ identityId: identity.id }),
        resolve: (item, resolution) =>
          origin.client.messaging.outbound.resolve({
            identityId: identity.id,
            outboundId: item.id,
            version: item.version,
            resolution,
          }),
        refreshContext: async () => {
          const next = await origin.client.messaging.status();
          if (!current()) return;
          await writeSaved(cache, queries.messaging.status.queryKey(), () => {
            if (!current()) throw new DOMException("Session changed", "AbortError");
            return next;
          });
        },
      }),
    [origin],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useLayoutEffect(() => {
    live.current = true;
    setRenewalError(null);
    return () => {
      live.current = false;
      controller.close();
    };
  }, [controller]);
  useEffect(() => {
    if (verified.current === origin || !sourceCurrent()) return;
    let active = true;
    const valid = () => active && live.current && sourceCurrent();
    void (async () => {
      const next = await origin.client.messaging.status();
      if (!valid()) return;
      await writeSaved(cache, queries.messaging.status.queryKey(), () => {
        if (!valid()) throw new DOMException("Session changed", "AbortError");
        return next;
      });
      if (!valid()) return;
      const match = next.identities.find((candidate) => candidate.id === identity.id);
      if (
        match?.botId !== identity.botId ||
        match.address !== identity.address ||
        match.provider !== identity.provider ||
        match.deliveryReview?.spaceId !== review.spaceId ||
        match.deliveryReview.count === 0
      )
        return;
      setRenewalError(null);
      setVerifiedOrigin(origin);
    })().catch((failure: unknown) => {
      if (valid()) setRenewalError(failure);
    });
    return () => {
      active = false;
    };
  }, [origin, identity]);
  const item = state.items[0];
  return (
    <div className="mt-2 space-y-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={state.pending || !owned()}
        onClick={() => void controller.load()}
      >
        <Trans>Review delivery</Trans>
      </Button>
      {renewalError && sourceCurrent() ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(renewalError, t`Couldn't load messaging settings`)}
        </p>
      ) : null}
      {state.opened ? (
        <div className="space-y-3 rounded-lg border p-3">
          {item ? (
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Check the chat first. Marking the result resumes queued messages without resending
                  this message.
                </Trans>
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{item.preview}</p>
              {item.attachmentName ? (
                <p className="break-words text-sm text-muted-foreground">{item.attachmentName}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.pending || Boolean(state.error) || !current()}
                  onClick={() => void controller.resolve(item, "confirmed_sent")}
                >
                  <Trans>Mark as sent</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.pending || Boolean(state.error) || !current()}
                  onClick={() => void controller.resolve(item, "confirmed_not_sent")}
                >
                  <Trans>Mark as not sent</Trans>
                </Button>
              </div>
            </>
          ) : null}
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorText(state.error, t`Couldn't update messaging settings`)}
            </p>
          ) : null}
          <Button size="sm" variant="ghost" disabled={state.pending} onClick={controller.close}>
            <Trans>Close</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
