// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@orkbot/chat-ui/web";
import type { ComputerReleaseReason, MessageBlock } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useQueryUserId } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import { selectedSpaceId } from "../../lib/rpc";
import { useBoundSpaceId } from "../../lib/space-rpc";

type ComputerCardProps = {
  block: Extract<MessageBlock, { kind: "computer" }>;
  botId?: string;
  runId?: string;
  messageId: string;
  threadId: string;
  rpc: ReturnType<typeof createSpaceRpc>;
  onOpen: (botId: string) => void;
  onRefresh: () => Promise<void>;
};

const cardClass =
  "w-[340px] max-w-full rounded-[18px] border border-border bg-muted px-[18px] py-4";
const bodyClass = "my-2.5 text-[14.5px] leading-[1.5] text-foreground/75";

function requestError(error: unknown) {
  if (typeof error !== "object" || error === null || !("status" in error)) return "failed";
  if (error.status === 409) return "closed";
  if (error.status === 403 || error.status === 404) return "forbidden";
  return "failed";
}

export function ComputerCard({
  block,
  botId,
  runId,
  messageId,
  threadId,
  rpc,
  onOpen,
  onRefresh,
}: ComputerCardProps) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const spaceId = useBoundSpaceId() ?? selectedSpaceId();
  const [resolved, setResolved] = useState<ComputerReleaseReason>();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<ReturnType<typeof requestError>>();
  const state = resolved === "done" ? "Done" : resolved === "skipped" ? "Skipped" : block.state;
  const waiting = state === "Needs you";
  const preview = useQuery({
    queryKey: ["takeoverPreview", userId, spaceId, threadId, botId, runId, messageId],
    queryFn: ({ signal }) =>
      rpc.computer.takeoverPreview({ botId: botId!, runId: runId!, messageId }, { signal }),
    enabled:
      waiting && Boolean(botId && runId) && actionError !== "closed" && actionError !== "forbidden",
    refetchOnWindowFocus: "always",
    retry: false,
    gcTime: 0,
  });
  const previewError = preview.isError ? requestError(preview.error) : undefined;
  const issue = previewError && previewError !== "failed" ? previewError : actionError;
  const closed = issue === "closed" || issue === "forbidden";
  const frame = !closed && !preview.isFetching && !preview.isError ? preview.data : null;

  async function respond(reason?: ComputerReleaseReason) {
    if (!botId || pending || closed) return;
    if (!runId) {
      onOpen(botId);
      return;
    }
    setPending(true);
    setActionError(undefined);
    try {
      if (reason) {
        const result = await rpc.computer.release({ botId, runId, messageId, reason });
        if (!result.resolved) {
          setActionError("failed");
          return;
        }
        setResolved(reason);
        void onRefresh().catch(() => undefined);
      } else {
        await rpc.computer.takeover({ botId, runId, messageId });
        onOpen(botId);
      }
    } catch (error) {
      setActionError(requestError(error));
    } finally {
      setPending(false);
    }
  }

  const originalText = (
    <div className={bodyClass}>
      <ChatMarkdown>{block.text}</ChatMarkdown>
    </div>
  );
  const title = (
    <span className="text-[15px] font-medium text-foreground">
      <Trans>Computer</Trans>
    </span>
  );
  if (state === "Done" || state === "Skipped") {
    return (
      <article data-testid="computer-card" className={cardClass}>
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {title}
            <span className="ml-3 text-[13px]">{state === "Done" ? t`Done` : t`Skipped`}</span>
          </summary>
          {originalText}
        </details>
      </article>
    );
  }

  return (
    <article data-testid="computer-card" className={cardClass}>
      <div className="flex items-center justify-between">
        {title}
        <span className="rounded-full bg-warning/15 px-[11px] py-1 text-[13px] text-warning">
          {waiting ? t`Needs you` : state}
        </span>
      </div>
      {originalText}
      {waiting && botId && runId && !closed && (
        <div className="mb-3">
          {frame ? (
            <img
              alt={t`Computer screen preview`}
              className="max-h-48 w-full rounded-lg border border-border object-contain"
              src={`data:${frame.mimeType};base64,${frame.data}`}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {preview.isFetching ? t`Loading preview…` : t`Computer screen preview unavailable`}
            </p>
          )}
        </div>
      )}
      {waiting && issue ? (
        <p role="alert" className="my-2 text-sm text-muted-foreground">
          {issue === "closed"
            ? t`This computer request is no longer waiting`
            : issue === "forbidden"
              ? t`You do not have access to this computer request`
              : t`Could not continue`}
        </p>
      ) : null}
      {botId && !(waiting && closed) && (
        <footer className="flex flex-wrap gap-2">
          {waiting && runId && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => void respond("skipped")}
              >
                <Trans>Skip</Trans>
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => void respond("done")}
              >
                <Trans>Done</Trans>
              </Button>
            </>
          )}
          <Button
            size="sm"
            data-testid="computer-card-open"
            disabled={pending}
            onClick={() => (waiting ? void respond() : onOpen(botId))}
          >
            {waiting ? t`Take control` : t`Open`}
          </Button>
        </footer>
      )}
    </article>
  );
}
