# Messaging

Inbound messaging, delivery receipts, webhook authentication, and email-provider selection live here, translating external deliveries into thread work and waking matching routines. Team-chat coordination belongs to `bots`, while thread state and stopping runs belong to `threads`.

Use `createMessagingInboundHandler` and `createMessagingReceipts` for delivery services, `mountMessagingWebhookRoutes` and `mountWebhookHttpRoutes` to install HTTP handlers, and `messagingRoutes` for RPC handlers. `configuredEmailProvider` selects the application's email adapter.
