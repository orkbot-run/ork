// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RpcInput, RpcOutput } from "@orkbot/contracts";
import { workspaceAIUpdate } from "@orkbot/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";
import { LoadFailure } from "./load-failure";
import { NativeActionButton } from "./native-action-button";
import { ServerAIAccountForm } from "./server-ai-account-form";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-group";
import { WorkspaceAIAccountForm } from "./workspace-ai-account-form";

type Assignment = RpcOutput<"serverAI/status">["connections"][number];
export function ServerAISettings({
  send,
  isCurrent,
  spaceId,
}: {
  send: typeof rpc;
  isCurrent(): boolean;
  spaceId?: string;
}) {
  const { t } = useI18n();
  const status = useQuery(
    { ...rpcQuery("serverAI/status", undefined, spaceId), queryFn: () => send("serverAI/status") },
    queryClient,
  );
  const policy = useQuery(
    {
      ...rpcQuery("models/workspacePolicy", undefined, spaceId),
      queryFn: () => send("models/workspacePolicy"),
    },
    queryClient,
  );
  const catalog = useQuery(
    {
      ...rpcQuery("serverAI/catalog", undefined, spaceId),
      queryFn: () => send("serverAI/catalog"),
      enabled: status.data?.canManageServer === true,
    },
    queryClient,
  );
  const [adding, setAdding] = useState(false);
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [editingAssignment, setEditingAssignment] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const refresh = async () => {
    await status.refetch();
    await policy.refetch();
    if (!isCurrent()) return;
    const me = await send("me");
    if (isCurrent()) queryClient.setQueryData(rpcQuery("me", undefined, spaceId).queryKey, me);
  };
  async function action(work: (signal: AbortSignal) => Promise<unknown>) {
    if (operation.current || !isCurrent()) return false;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      await work(controller.signal);
      if (isCurrent() && !controller.signal.aborted) await refresh();
      return !controller.signal.aborted && isCurrent();
    } catch {
      if (isCurrent() && !controller.signal.aborted) setError(t("Could not save"));
      return false;
    } finally {
      if (operation.current === controller) operation.current = null;
      if (isCurrent() && !controller.signal.aborted) setBusy(false);
    }
  }
  const configure = (row: Assignment, patch: Partial<RpcInput<"serverAI/configure">>) =>
    action(async (signal) => {
      await send("serverAI/configure", workspaceAIUpdate(row, patch), { signal });
    });
  if (status.isPending) return <ActivityIndicator />;
  if (status.isError || !status.data)
    return (
      <LoadFailure
        message={t("Could not load model settings")}
        onRetry={() => void status.refetch()}
      />
    );
  const value = status.data;
  if (value.modelSetupMode === "pending")
    return (
      <View style={{ gap: 16 }}>
        {value.canManageServer ? (
          <Text style={{ color: native.secondaryLabel }}>
            {t(
              "Model keys are managed by this server, not Ork Accounts. The server operator is responsible for them.",
            )}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: native.label }}>
            {error}
          </Text>
        ) : null}
        {!value.canManageServer && value.adminAccessReason === "role_unavailable" ? (
          <Text style={{ color: native.secondaryLabel }}>
            {t(
              "Your organization role could not be verified. Check that Accounts and this server are up to date.",
            )}
          </Text>
        ) : null}
        {!value.canManageServer && value.adminAccessReason === "unverified" ? (
          <Text style={{ color: native.secondaryLabel }}>
            {t(
              "Administrator access could not be verified. Sign in again or check the server configuration.",
            )}
          </Text>
        ) : null}
        {value.canManageServer ? (
          <>
            <Text style={{ color: native.secondaryLabel }}>
              {t("Choose how people in your organization will connect models.")}
            </Text>
            <NativeActionButton
              label={t("Connect organization models")}
              disabled={busy}
              onPress={() =>
                void action((signal) =>
                  send("serverAI/chooseMode", { mode: "organization" }, { signal }),
                )
              }
            />
            <NativeActionButton
              label={t("Let people connect their own models")}
              disabled={busy}
              onPress={() =>
                void action((signal) =>
                  send("serverAI/chooseMode", { mode: "personal" }, { signal }),
                )
              }
            />
            <Text style={{ color: native.secondaryLabel }}>
              {t("Personal models may process workspace data outside company servers.")}
            </Text>
          </>
        ) : (
          <Text style={{ color: native.secondaryLabel }}>
            {t("Waiting for an organization administrator to set up models.")}
          </Text>
        )}
      </View>
    );
  return (
    <View style={{ gap: 16 }}>
      {value.canManageServer ? (
        <Text style={{ color: native.secondaryLabel }}>
          {t(
            "Model keys are managed by this server, not Ork Accounts. The server operator is responsible for them.",
          )}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: native.label }}>
          {error}
        </Text>
      ) : null}
      {!value.canManageServer && value.adminAccessReason === "role_unavailable" ? (
        <Text style={{ color: native.secondaryLabel }}>
          {t(
            "Your organization role could not be verified. Check that Accounts and this server are up to date.",
          )}
        </Text>
      ) : null}
      {!value.canManageServer && value.adminAccessReason === "unverified" ? (
        <Text style={{ color: native.secondaryLabel }}>
          {t(
            "Administrator access could not be verified. Sign in again or check the server configuration.",
          )}
        </Text>
      ) : null}
      {value.canManageServer &&
      (value.modelSetupMode === "personal" || value.modelSetupMode === "organization") ? (
        <NativeActionButton
          label={
            value.modelSetupMode === "personal"
              ? t("Use organization models")
              : t("Allow personal models")
          }
          disabled={busy}
          onPress={() =>
            void action((signal) =>
              send(
                "serverAI/chooseMode",
                { mode: value.modelSetupMode === "personal" ? "organization" : "personal" },
                { signal },
              ),
            )
          }
        />
      ) : null}
      {policy.data?.personalModelsAllowed ? (
        <Text style={{ color: native.secondaryLabel }}>
          {t("Your organization allows personal models.")}{" "}
          {t("Personal models may process workspace data outside company servers.")}
        </Text>
      ) : null}
      {value.canManageWorkspace && value.workspaceMonthlyBudgetMicros !== null ? (
        <NativeActionButton
          label={t("Remove existing workspace spending limits")}
          disabled={busy}
          onPress={() =>
            void action((signal) =>
              send("serverAI/workspaceBudget", { monthlyBudgetMicros: null }, { signal }),
            )
          }
        />
      ) : null}
      {value.modelSetupMode !== "personal" &&
        value.connections.map((row) => (
          <SettingsGroup key={row.id} label={row.label}>
            <SettingsRow
              title={row.provider}
              value={
                row.blockedByPolicy
                  ? t("Blocked by the server administrator")
                  : row.state === "active"
                    ? (row.defaultModelId ?? "")
                    : t("Reconnect")
              }
            />
            {value.canManageWorkspace ? (
              <>
                <SettingsSwitch
                  label={t("Enabled")}
                  value={row.enabled}
                  disabled={
                    busy || (!row.enabled && (row.blockedByPolicy || row.state !== "active"))
                  }
                  onChange={(enabled) => void configure(row, { enabled })}
                />
                <SettingsSwitch
                  label={t("Default")}
                  value={row.isDefault && row.enabled}
                  disabled={busy || row.blockedByPolicy || !row.enabled || row.state !== "active"}
                  onChange={(isDefault) => void configure(row, { isDefault })}
                />
                <SettingsSwitch
                  label={t("Fallback")}
                  value={row.fallback}
                  disabled={busy || row.blockedByPolicy || !row.enabled || row.state !== "active"}
                  onChange={(fallback) => void configure(row, { fallback })}
                />
              </>
            ) : null}
            {value.canManageWorkspace ? (
              <SettingsRow
                title={t("Models")}
                onPress={() => setEditingAssignment(editingAssignment === row.id ? null : row.id)}
                disabled={busy}
                chevron="right"
              />
            ) : null}
            {editingAssignment === row.id ? (
              <WorkspaceAIAccountForm
                key={`${row.id}:${row.assignmentRevision}`}
                row={row}
                hideBudget
                busy={busy}
                onSave={(patch) => configure(row, patch)}
                onCancel={() => setEditingAssignment(null)}
              />
            ) : null}
            {value.canManageWorkspace && row.monthlyBudgetMicros !== null ? (
              <SettingsRow
                title={t("Remove existing model spending limit")}
                disabled={busy}
                onPress={() => void configure(row, { monthlyBudgetMicros: null })}
              />
            ) : null}
          </SettingsGroup>
        ))}
      {value.canManageServer && value.modelSetupMode !== "personal" ? (
        <>
          <SettingsGroup label={t("Organization connections")}>
            {value.accounts.map((row) => (
              <View key={row.id}>
                {row.monthlyBudgetMicros !== null ? (
                  <SettingsRow
                    title={t("Remove existing account spending limit")}
                    disabled={busy}
                    onPress={() =>
                      void action((signal) =>
                        send(
                          "serverAI/update",
                          {
                            connectionId: row.id,
                            label: row.label,
                            models: row.models,
                            concurrencyLimit: row.concurrencyLimit,
                            monthlyBudgetMicros: null,
                          },
                          { signal },
                        ),
                      )
                    }
                  />
                ) : null}
                <SettingsRow
                  title={row.label}
                  detail={
                    row.blockedByPolicy ? t("Blocked by the server administrator") : row.provider
                  }
                  onPress={() => {
                    setAdding(false);
                    setEditingAccount(editingAccount === row.id ? null : row.id);
                  }}
                  disabled={busy}
                  chevron="right"
                />
                {value.connections.some((assigned) => assigned.id === row.id) ? (
                  <SettingsRow
                    title={t("Remove from organization")}
                    destructive
                    disabled={busy}
                    onPress={() =>
                      void action((signal) =>
                        send(
                          "serverAI/offer",
                          { spaceId: value.spaceId, connectionId: row.id, available: false },
                          { signal },
                        ),
                      )
                    }
                  />
                ) : (
                  <SettingsRow
                    title={t("Make available to organization")}
                    disabled={busy || row.blockedByPolicy || row.state !== "active"}
                    onPress={() =>
                      void action((signal) =>
                        send(
                          "serverAI/offer",
                          { spaceId: value.spaceId, connectionId: row.id, available: true },
                          { signal },
                        ),
                      )
                    }
                  />
                )}
                {row.state !== "disabled" ? (
                  <SettingsRow
                    title={t("Disable connection")}
                    destructive
                    disabled={busy}
                    onPress={() =>
                      void action((signal) =>
                        send("serverAI/disable", { connectionId: row.id }, { signal }),
                      )
                    }
                  />
                ) : null}
              </View>
            ))}
          </SettingsGroup>
          {editingAccount && catalog.data ? (
            <ServerAIAccountForm
              hideBudget
              key={editingAccount}
              account={value.accounts.find((row) => row.id === editingAccount)}
              catalog={catalog.data}
              send={send}
              isCurrent={isCurrent}
              onSaved={async () => {
                setEditingAccount(null);
                await refresh();
              }}
              onCancel={() => setEditingAccount(null)}
            />
          ) : null}
          {adding && catalog.data ? (
            <ServerAIAccountForm
              hideBudget
              catalog={catalog.data}
              send={send}
              isCurrent={isCurrent}
              onSaved={async () => {
                setAdding(false);
                await refresh();
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <NativeActionButton
              label={t("Add model connection")}
              disabled={busy || !catalog.data}
              onPress={() => {
                setEditingAccount(null);
                setAdding(true);
              }}
            />
          )}
          {catalog.isError ? (
            <LoadFailure
              message={t("Could not load model settings")}
              onRetry={() => void catalog.refetch()}
            />
          ) : null}
        </>
      ) : null}
      {!value.connections.length ? (
        <SettingsGroup>
          <SettingsRow title={t("No model connections available")} />
        </SettingsGroup>
      ) : null}
    </View>
  );
}
