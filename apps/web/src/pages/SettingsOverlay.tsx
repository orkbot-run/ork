// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 code remains separately licensed. Generator-only avatar editing is an Ork addition.

import { useLingui } from "@lingui/react/macro";
import type { ComputerCapabilities, Me, SpaceMemoryConfig } from "@orkbot/contracts";
import { organizationDashboardUrl, organizationIntegrationsUrl } from "@orkbot/contracts";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@orkbot/ui-web";
import { ORPCError } from "@orpc/client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { AuditLog } from "../components/AuditLog";
import { computersAreUnavailable } from "../components/ComputersUnavailableHint";
import { SETTINGS_CONTENT_WIDTH, SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { VaultSettings } from "../components/VaultSettings";

import { exportOrganizationAudit } from "../lib/audit-export";
import { desktopBridge } from "../lib/desktop";
import { useQueryUserId, useSpaceQueries } from "../lib/query";
import { selectedSpaceId } from "../lib/rpc";
import { useServerUpdates } from "../lib/server-updates";
import { SpaceRpcProvider } from "../lib/space-rpc";
import {
  ComputerSettingsPanel,
  GeneralSettingsPanels,
  UpdatesSettingsPanel,
} from "./AccountSettingsOverlay";
import { BillingSettingsPanel } from "./BillingSettingsPanel";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { MessagingSettingsPanel } from "./MessagingSettingsPanel";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import {
  OrganizationSettingsActions,
  OrganizationSettingsPanel,
} from "./OrganizationSettingsPanel";
import { OrganizationVaultSettings } from "./OrganizationVaultSettings";
import { PaymentWalletSettingsPanel } from "./PaymentWalletSettingsPanel";
import { ServerAISettings } from "./ServerAISettings";
import { SpaceSettingsPanel } from "./SpaceSettingsPanel";
import { useSettingsNavItems } from "./settings-nav";
import type { SettingsSpace } from "./shell/dialogs";
import type { SettingsSection } from "./shell-overlay";
import { UsageSettingsPanel } from "./UsageSettingsPanel";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

export function SettingsOverlay({
  space,
  spaces = [],
  onOpenSpace,
  onRenameSpace,
  onDeleteSpace,
  email,
  name,
  section: requestedSection,
  onSectionChange,
  onNameSaved,
  timezone,
  onTimezoneChange,
  onAccountImported,
  onImportAgent,
  billingEnabled = false,
  computerCapabilities,
  canConfigureAccountComputers = false,
  onComputerConfigurationChange,
  canConfigureComputers = false,
  messagingEnabled = false,
  paymentWalletProvider = null,
  memoryConfig,
  onMemoryConfigChange,
  onClose,
  onVoiceStatusMaybeChanged,
}: {
  /** The space the Space page edits; it need not be the selected space. */
  space?: SettingsSpace | null;
  spaces?: { id: string; name: string }[];
  onOpenSpace?: (spaceId: string) => void;
  onRenameSpace?: (spaceId: string, name: string) => Promise<void>;
  onDeleteSpace?: (spaceId: string) => Promise<void>;
  email?: string | null;
  name: string;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onNameSaved?: () => Promise<void>;
  timezone: string | null;
  onTimezoneChange: (timezone: string) => Promise<void>;
  onAccountImported?: () => Promise<void>;
  onImportAgent?: () => void;
  billingEnabled?: boolean;
  computerCapabilities?: ComputerCapabilities | null;
  canConfigureAccountComputers?: boolean;
  onComputerConfigurationChange?: (me: Me) => void;
  /** Admins choose where new computers run. */
  canConfigureComputers?: boolean;
  messagingEnabled?: boolean;
  /** The wallet this deployment lets bots spend from; none hides Wallet. */
  paymentWalletProvider?: { id: string; name: string } | null;
  memoryConfig: SpaceMemoryConfig | null | undefined;
  onMemoryConfigChange: (config: SpaceMemoryConfig | null) => void;
  onClose: () => void;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
}) {
  const { t, i18n } = useLingui();
  const userId = useQueryUserId();
  const queries = useSpaceQueries();
  const auditSpaceId = selectedSpaceId();
  const modelPolicy = useQuery(queries.models.workspacePolicy.queryOptions());
  const [accountsUrl, setAccountsUrl] = useState<string | null>(null);
  const [integrationsUrl, setIntegrationsUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!modelPolicy.data?.managed) return;
    let current = true;
    setAccountsUrl(null);
    setIntegrationsUrl(null);
    void Promise.resolve()
      .then(() => desktopBridge()?.accounts?.workspaceTarget?.())
      .then((target) => {
        if (current) {
          setAccountsUrl(organizationDashboardUrl(target?.organizationId));
          setIntegrationsUrl(organizationIntegrationsUrl(target?.organizationId));
        }
      })
      .catch(() => {
        if (current) {
          setAccountsUrl(organizationDashboardUrl());
          setIntegrationsUrl(organizationIntegrationsUrl());
        }
      });
    return () => {
      current = false;
    };
  }, [modelPolicy.data?.managed, space?.id]);
  const audit = useInfiniteQuery(
    queries.audit.events.infiniteOptions({
      input: (cursor: string | null) => ({ limit: 25, cursor: cursor ?? undefined }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
      enabled: requestedSection === "organization" || requestedSection === "organization-activity",
      staleTime: 0,
      gcTime: 0,
    }),
  );
  const auditForbidden = audit.error instanceof ORPCError && audit.error.code === "FORBIDDEN";
  const canReadAudit = audit.data !== undefined && !auditForbidden;
  const panelRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [navOverflow, setNavOverflow] = useState({ previous: false, next: false });
  const usageRef = useRef<HTMLDivElement>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [keepComputerRecovery, setKeepComputerRecovery] = useState(false);
  const recoveryHoldTimer = useRef<number | undefined>(undefined);
  const showComputer =
    canConfigureComputers ||
    keepComputerRecovery ||
    computersAreUnavailable(computerCapabilities) ||
    canConfigureAccountComputers;
  const serverUpdates = useServerUpdates(requestedSection === "updates");
  const showUpdates =
    Boolean(desktopBridge()?.update) || serverUpdates.state.status?.available === true;
  // A section that isn't available yet (billing before its flag loads) shows General until it is.
  const unavailable =
    (requestedSection === "computer" && !showComputer) ||
    (requestedSection === "billing" && !billingEnabled) ||
    (requestedSection === "messaging" && !messagingEnabled) ||
    (requestedSection === "wallet" && !paymentWalletProvider) ||
    (requestedSection === "updates" && !showUpdates);
  const section =
    requestedSection === "organization-activity" && auditForbidden
      ? "organization"
      : unavailable
        ? "general"
        : requestedSection;
  useEffect(() => {
    if (requestedSection === "organization-activity" && auditForbidden)
      onSectionChange("organization");
  }, [auditForbidden, onSectionChange, requestedSection]);
  const panelBusy = memoryBusy || voiceBusy;
  // Only a space's own page binds to it; every other section, memory included, acts on the
  // space the app is showing.
  const spaceId = section === "space" ? (space?.id ?? null) : null;
  const releaseComputerRecovery = useCallback(() => {
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = undefined;
    setKeepComputerRecovery(false);
  }, []);
  const holdComputerRecovery = useCallback(() => {
    setKeepComputerRecovery(true);
    window.clearTimeout(recoveryHoldTimer.current);
    recoveryHoldTimer.current = window.setTimeout(() => {
      recoveryHoldTimer.current = undefined;
      setKeepComputerRecovery(false);
    }, 4000);
  }, []);

  useEffect(() => {
    if (section !== "computer") releaseComputerRecovery();
  }, [section, releaseComputerRecovery]);
  useEffect(() => () => window.clearTimeout(recoveryHoldTimer.current), []);

  useEffect(() => {
    if (section === "usage") {
      usageRef.current?.focus();
    }
  }, [section]);

  const allNavItems = useSettingsNavItems({
    messaging: messagingEnabled,
    wallet: Boolean(paymentWalletProvider),
    computer: showComputer,
    billing: billingEnabled,
    updates: showUpdates,
    organizationModels: modelPolicy.data?.managed === true,
  });
  const organizationScope =
    modelPolicy.data?.managed === true &&
    (section === "organization" ||
      section === "organization-models" ||
      section === "organization-vault" ||
      section === "organization-activity");
  const navItems = modelPolicy.data?.managed
    ? allNavItems.filter((item) =>
        organizationScope
          ? item.id === "organization" ||
            item.id === "organization-models" ||
            item.id === "organization-vault"
          : item.id !== "organization" &&
            item.id !== "organization-models" &&
            item.id !== "organization-vault",
      )
    : allNavItems;

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const offset = Math.abs(nav.scrollLeft);
      setNavOverflow({
        previous: offset > 1,
        next: nav.scrollWidth - nav.clientWidth - offset > 1,
      });
    };
    const revealSection = () => {
      if (nav.scrollWidth > nav.clientWidth) {
        nav.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }
      measure();
    };
    revealSection();
    nav.addEventListener("scroll", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(revealSection);
    observer?.observe(nav);
    return () => {
      nav.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [
    section,
    showComputer,
    billingEnabled,
    messagingEnabled,
    paymentWalletProvider,
    showUpdates,
    i18n.locale,
  ]);

  function scrollSections(direction: number) {
    const nav = navRef.current;
    if (!nav) return;
    const rtl = getComputedStyle(nav).direction === "rtl";
    nav.scrollBy({ left: nav.clientWidth * 0.75 * direction * (rtl ? -1 : 1), behavior: "smooth" });
  }

  const sectionTitle =
    section === "space"
      ? (space?.name ?? t`Space`)
      : section === "organization-activity"
        ? t`Activity log`
        : (navItems.find((item) => item.id === section)?.label ??
          (section === "general" ? t`General` : t`Settings`));

  const closeLabel =
    section === "models"
      ? t`Close model settings`
      : section === "memory"
        ? t`Close memory settings`
        : section === "voice"
          ? t`Close voice settings`
          : t`Close user settings`;

  async function refreshVoiceStatus() {
    await onVoiceStatusMaybeChanged?.();
  }

  // Leaving is immediate, so the URL updates in the same tick; voice readiness refreshes behind it.
  function leaveSettings(next: () => void) {
    if (panelBusy) return;
    void refreshVoiceStatus();
    next();
  }

  function requestClose() {
    leaveSettings(onClose);
  }

  async function exportAudit(signal: AbortSignal) {
    try {
      await exportOrganizationAudit(auditSpaceId, signal);
    } catch (error) {
      if (!signal.aborted && error instanceof ORPCError && error.code === "FORBIDDEN")
        void audit.refetch();
      throw error;
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (panelBusy) {
          details.cancel();
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        showCloseButton={false}
        initialFocus={() =>
          section === "usage" ? (usageRef.current ?? panelRef.current) : panelRef.current
        }
        className="flex h-[min(760px,calc(100%-2rem))] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[calc(100%-5rem)] sm:max-w-[1080px]"
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 md:contents">
            {/* Reserve arrow space so showing controls does not change the overflow measurement. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Previous settings sections`}
              disabled={!navOverflow.previous || panelBusy}
              onClick={() => scrollSections(-1)}
            >
              <ChevronLeft className="rtl:rotate-180" />
            </Button>
            <nav
              ref={navRef}
              data-testid="settings-nav"
              aria-label={t`Settings`}
              className="flex min-w-0 flex-1 flex-row gap-1 overflow-x-auto py-3 md:w-[200px] md:shrink-0 md:flex-none md:flex-col md:overflow-y-auto md:border-e md:border-border md:bg-sidebar md:px-3 md:py-4"
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                const active =
                  item.id ===
                  (section === "space"
                    ? "general"
                    : section === "organization-activity"
                      ? "organization"
                      : section);
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`settings-nav-${item.id}`}
                    aria-current={active ? "page" : undefined}
                    disabled={panelBusy}
                    onClick={() => onSectionChange(item.id)}
                    className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                );
              })}
              {modelPolicy.data?.managed ? (
                <button
                  type="button"
                  disabled={panelBusy}
                  onClick={() => onSectionChange(organizationScope ? "general" : "organization")}
                  className="flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="whitespace-nowrap">
                    {organizationScope ? t`Your settings` : t`Organization settings`}
                  </span>
                </button>
              ) : null}
            </nav>
            <Button
              variant="ghost"
              size="icon-sm"
              className={`shrink-0 md:hidden ${navOverflow.previous || navOverflow.next ? "" : "invisible"}`}
              aria-label={t`Next settings sections`}
              disabled={!navOverflow.next || panelBusy}
              onClick={() => scrollSections(1)}
            >
              <ChevronRight className="rtl:rotate-180" />
            </Button>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              data-testid="settings-header"
              className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 pb-5 pt-6 sm:px-8 sm:pt-7"
            >
              <div className="flex min-w-0 items-center gap-2">
                {section === "space" || section === "organization-activity" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-ms-2 shrink-0"
                    aria-label={t`Back`}
                    disabled={panelBusy}
                    onClick={() =>
                      onSectionChange(section === "space" ? "general" : "organization")
                    }
                  >
                    <ChevronLeft className="rtl:rotate-180" />
                  </Button>
                ) : null}
                <DialogTitle className="min-w-0 break-words text-heading2 font-medium text-foreground">
                  {sectionTitle}
                </DialogTitle>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {section === "organization" ? (
                  <OrganizationSettingsActions
                    allowDelete={modelPolicy.isSuccess && modelPolicy.data?.managed !== true}
                    disabled={panelBusy}
                    onOpenAudit={
                      canReadAudit ? () => onSectionChange("organization-activity") : undefined
                    }
                  />
                ) : null}
                <DialogClose
                  aria-label={closeLabel}
                  disabled={panelBusy}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <XIcon />
                </DialogClose>
              </div>
            </div>

            <SpaceRpcProvider spaceId={spaceId}>
              <div
                key={spaceId ?? "selected"}
                data-testid="settings-scroll"
                className={`min-h-0 flex-1 ${
                  section === "memory"
                    ? "flex flex-col overflow-hidden"
                    : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-6 sm:px-8 sm:pb-8"
                }`}
              >
                <div
                  className={
                    section === "memory" ||
                    section === "usage" ||
                    section === "organization-activity"
                      ? "contents"
                      : SETTINGS_CONTENT_WIDTH
                  }
                >
                  {section === "general" ? (
                    <div className="space-y-8">
                      <GeneralSettingsPanels
                        email={email}
                        name={name}
                        onNameSaved={onNameSaved}
                        timezone={timezone}
                        onTimezoneChange={onTimezoneChange}
                        onAccountImported={onAccountImported}
                        onImportAgent={onImportAgent}
                      />
                      {/* One space is just the app, so there is nothing to tell apart or manage. */}
                      {spaces.length > 1 && onOpenSpace ? (
                        <SettingsGroup title={t`Spaces`} data-testid="settings-spaces">
                          {spaces.map((option) => (
                            <SettingsRow
                              key={option.id}
                              label={<p className="break-words">{option.name}</p>}
                              control={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="rounded-full"
                                  aria-label={t`Manage ${option.name}`}
                                  onClick={() => onOpenSpace(option.id)}
                                >
                                  {t`Manage`}
                                </Button>
                              }
                            />
                          ))}
                        </SettingsGroup>
                      ) : null}
                    </div>
                  ) : null}
                  {section === "space" && space ? (
                    <SpaceSettingsPanel
                      managedModels={modelPolicy.data?.managed === true}
                      key={space.id}
                      space={space}
                      onRename={(name) => onRenameSpace?.(space.id, name) ?? Promise.resolve()}
                      onDelete={() => onDeleteSpace?.(space.id) ?? Promise.resolve()}
                      onClose={requestClose}
                      onBusyChange={setVoiceBusy}
                    />
                  ) : null}
                  {section === "organization" ? (
                    modelPolicy.isPending ? (
                      <p>{t`Loading organization settings…`}</p>
                    ) : modelPolicy.isError ? (
                      <div>
                        <p role="alert">{t`Could not load organization settings.`}</p>
                        <Button
                          variant="outline"
                          onClick={() => void modelPolicy.refetch()}
                        >{t`Retry`}</Button>
                      </div>
                    ) : modelPolicy.data?.managed ? (
                      <div className="grid gap-4">
                        <p className="text-sm text-muted-foreground">{t`Manage your organization, servers and people in Ork Accounts.`}</p>
                        <Button
                          variant="outline"
                          className="w-fit"
                          disabled={!accountsUrl}
                          onClick={() => {
                            if (accountsUrl)
                              window.open(accountsUrl, "_blank", "noopener,noreferrer");
                          }}
                        >{t`Open Ork Accounts`}</Button>
                        <Button
                          variant="outline"
                          className="w-fit"
                          disabled={!integrationsUrl}
                          onClick={() => {
                            if (integrationsUrl)
                              window.open(integrationsUrl, "_blank", "noopener,noreferrer");
                          }}
                        >{t`Organization integrations`}</Button>
                        <p className="text-sm text-muted-foreground">{t`Organization administrators manage integrations in Ork Accounts.`}</p>
                        <Button
                          variant="outline"
                          className="w-fit"
                          onClick={() => onSectionChange("organization-models")}
                        >{t`Organization models`}</Button>
                      </div>
                    ) : (
                      <OrganizationSettingsPanel onBusyChange={setVoiceBusy} />
                    )
                  ) : null}
                  {section === "organization-models" && modelPolicy.data?.managed ? (
                    <ServerAISettings embedded onClose={requestClose} />
                  ) : null}
                  {section === "organization-vault" && modelPolicy.data?.managed ? (
                    <OrganizationVaultSettings />
                  ) : null}
                  {section === "organization-activity" && !auditForbidden ? (
                    <AuditLog
                      key={JSON.stringify([userId, auditSpaceId])}
                      events={audit.data?.pages.flatMap((page) => page.events) ?? []}
                      loading={audit.isPending}
                      loadFailed={audit.isError}
                      loadingMore={audit.isFetchingNextPage}
                      hasMore={audit.hasNextPage}
                      onRetry={() => {
                        if (audit.isFetchNextPageError) void audit.fetchNextPage();
                        else void audit.refetch();
                      }}
                      onLoadMore={() => void audit.fetchNextPage({ cancelRefetch: false })}
                      onExport={exportAudit}
                      timezone={timezone}
                    />
                  ) : null}
                  {section === "confirmations" ? <ApprovalRulesSettings scope="account" /> : null}
                  {section === "vault" ? <VaultSettings scope="account" /> : null}
                  {section === "messaging" && messagingEnabled ? <MessagingSettingsPanel /> : null}
                  {section === "wallet" && paymentWalletProvider ? (
                    <PaymentWalletSettingsPanel provider={paymentWalletProvider} />
                  ) : null}
                  {section === "usage" ? <UsageSettingsPanel panelRef={usageRef} /> : null}
                  {section === "computer" && showComputer ? (
                    <ComputerSettingsPanel
                      computerCapabilities={computerCapabilities}
                      canConfigureAccountComputers={canConfigureAccountComputers}
                      onComputerConfigurationChange={(next) => {
                        onComputerConfigurationChange?.(next);
                        holdComputerRecovery();
                      }}
                      onRecoveryDismissed={releaseComputerRecovery}
                      canConfigureComputers={canConfigureComputers}
                    />
                  ) : null}
                  {section === "billing" && billingEnabled ? <BillingSettingsPanel /> : null}
                  {section === "updates" && showUpdates ? (
                    <UpdatesSettingsPanel serverUpdates={serverUpdates} />
                  ) : null}
                  {section === "models" ? (
                    <ModelSettingsOverlay embedded scope="account" onClose={requestClose} />
                  ) : null}
                  {section === "memory" ? (
                    <MemorySettingsOverlay
                      embedded
                      onClose={requestClose}
                      config={memoryConfig}
                      onConfigChange={onMemoryConfigChange}
                      onBusyChange={setMemoryBusy}
                    />
                  ) : null}
                  {section === "voice" ? (
                    <VoiceSettingsOverlay
                      embedded
                      scope="account"
                      onClose={requestClose}
                      onBusyChange={setVoiceBusy}
                    />
                  ) : null}
                </div>
              </div>
            </SpaceRpcProvider>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
