// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 material is preserved. Server update additions follow LICENSE.md.

import type {
  AgentHomeStore,
  ArtifactStore,
  JobPublisher,
  MemoryStore,
  NotificationProvider,
  PaymentWalletProvider,
  ProductAnalytics,
  SandboxProvider,
  SecretStore,
  TransactionalEmailProvider,
} from "@orkbot/adapter-kit";
import type {
  CloudAgentConnection,
  CodexLiveCatalog,
  ConnectorRegistry,
  FaviconResolver,
  McpConnector,
  McpOAuthBroker,
  MemoryProviderResolver,
  MessagingInstallations,
  PiOAuthLogins,
  PluginRepoFetcher,
  PluginTextReader,
  ProviderCatalogCache,
  PushTokenStore,
  RemoteConnectorDependencies,
  ServerAICatalog,
  ServerAIModels,
  ServerAIOAuth,
  TicketChangeNotifier,
  verifyModelServesAgents,
} from "@orkbot/adapters";
import type { Auth } from "@orkbot/auth";
import type { NavLink } from "@orkbot/contracts";
import type { BoardEvents, PrismaClient, ThreadEvents } from "@orkbot/db";
import { accountRoutes } from "#modules/accounts/routes/account";
import { organizationsRoutes } from "#modules/accounts/routes/organizations";
import type { BillingService } from "#modules/billing/billing";
import { paymentWalletRoutes } from "#modules/billing/routes/payment-wallet";
import { botsRoutes } from "#modules/bots/routes/bots";
import { computerRoutes } from "#modules/computers/routes/computer";
import { computerProviderRoutes } from "#modules/computers/routes/computer-provider";
import { boardsRoutes } from "#modules/content/routes/boards";
import { contentRoutes } from "#modules/content/routes/content";
import { pagesRoutes } from "#modules/content/routes/pages";
import { connectionsRoutes } from "#modules/integrations/routes/connections";
import { mcpRoutes } from "#modules/mcp/routes/mcp";
import { memoryRoutes } from "#modules/memory/routes/memory";
import { messagingRoutes } from "#modules/messaging/routes/messaging";
import { modelsRoutes } from "#modules/models/routes/models";
import { serverAIRoutes } from "#modules/models/routes/server-ai";
import { routinesRoutes } from "#modules/routines/routes/routines";
import { serverUpdateRoutes } from "#modules/server-updates/routes";
import type { ServerUpdatesService } from "#modules/server-updates/service";
import { availabilityRoutes } from "#modules/spaces/routes/availability";
import { spacesRoutes } from "#modules/spaces/routes/spaces";
import { threadsRoutes } from "#modules/threads/routes/threads";
import type { VoiceDeps } from "#modules/voice/voice";
import { createRouterContext } from "./routes/context.js";

export { botIntroPrompt, enqueueBotIntroRun } from "#modules/bots/routes/bots";
export { nextConnectionLabel } from "#modules/models/model-credentials";
export { callMarkerClientNonce } from "#modules/threads/routes/threads";
export { HEARTBEAT_MS, SESSION_RECHECK_MS } from "./routes/shared.js";

export interface RouterDeps {
  serverAI?: ServerAICatalog;
  serverAIModels?: ServerAIModels;
  serverUpdates?: ServerUpdatesService;
  pushTokens: PushTokenStore;
  /** Stops a call's ring on the owner's other devices once it is settled. */
  notifications?: NotificationProvider;
  analytics?: ProductAnalytics;
  cloudAgent?: CloudAgentConnection | null;
  /** The deployment's wallet provider; absent hides purchases. */
  paymentWallet?: PaymentWalletProvider | null;
  prisma: PrismaClient;
  events: ThreadEvents;
  boardEvents: BoardEvents;
  ticketChanges: TicketChangeNotifier;
  auth: Auth;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  home: AgentHomeStore;
  secrets: SecretStore;
  oauthLogins: PiOAuthLogins;
  serverAIOAuth?: ServerAIOAuth;
  /** Live Codex catalog seam; defaults to the shared per-process cache. */
  codexCatalog?: CodexLiveCatalog;
  providerCatalog?: ProviderCatalogCache;
  /** HTTP transport for model connection checks and catalog probes. */
  modelConnectionFetch?: typeof fetch;
  /** One real request proving a newly keyed model can serve agents; absent skips it. */
  modelConnectionCheck?: typeof verifyModelServesAgents;
  /** Site icons for links; defaults to the per-process cache that fetches them. */
  favicons?: FaviconResolver;
  /** Detached refresh for an expired bearer, so the live catalog never refreshes inline. */
  refreshExpiredModelCredential?: (
    scope: { userId: string; spaceId: string },
    secretId: string,
    provider: string,
  ) => void;
  mcpOAuth?: McpOAuthBroker;
  /** Probes MCP server health; without it servers are never probed from here. */
  mcp?: Pick<McpConnector, "probe">;
  connectors: ConnectorRegistry;
  remoteConnectors?: RemoteConnectorDependencies;
  pluginRepoFetcher?: PluginRepoFetcher;
  pluginMarketplaceRead?: PluginTextReader;
  artifacts: ArtifactStore;
  dataDir: string;
  messagingInstallations?: MessagingInstallations;
  messaging?: {
    enabled: boolean;
    providers: string[];
    addresses: Record<string, string>;
    openSignup: boolean;
  };
  /** Present only when the deployment bills; self-hosted installs leave it unset. */
  billing?: BillingService;
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  speechSummary?: VoiceDeps["speechSummary"];
  env: {
    ticketBoardEnabled?: boolean;
    navLinks?: NavLink[];
    adminEmails?: string[];
    phoneCallsEnabled?: boolean;
    phoneCallRingSeconds?: number;
    maxUploadSizeBytes?: number;
    maxAttachmentsPerMessage?: number;
    agentRuntime: string;
    teamChatJudgeProvider?: string;
    teamChatJudgeModel?: string;
    defaultProvider: string;
    defaultModel: string;
    deploymentModelConfigured?: boolean;
    deploymentModelHostCredentials?: boolean;
    webOrigin: string;
    privacyPolicyUrl?: string;
    screenProxySecret: string;
    sandboxProvider: string;
    gitSha?: string;
    serverVersion?: string;
    integrationsCatalogUrl?: string;
    mcpAllowPrivateEndpoint?: boolean;
    desktopHostChoiceEnabled?: boolean;
    mcpStdioEnabled?: boolean;
    mcpStdioAllowedCommands?: string[];
  };
}

export function createRouter(deps: RouterDeps) {
  const ctx = createRouterContext(deps);
  const { os } = ctx;

  return os.router({
    ...accountRoutes(ctx),
    ...spacesRoutes(ctx),
    ...organizationsRoutes(ctx),
    ...modelsRoutes(ctx),
    ...serverAIRoutes(ctx),
    ...botsRoutes(ctx),
    ...threadsRoutes(ctx),
    ...computerRoutes(ctx),
    ...computerProviderRoutes(ctx),
    ...serverUpdateRoutes(ctx),
    ...memoryRoutes(ctx),
    ...routinesRoutes(ctx),
    ...boardsRoutes(ctx),
    ...mcpRoutes(ctx),
    ...availabilityRoutes(ctx),
    ...connectionsRoutes(ctx),
    ...messagingRoutes(ctx),
    ...contentRoutes(ctx),
    ...pagesRoutes(ctx),
    ...paymentWalletRoutes(ctx),
  });
}
