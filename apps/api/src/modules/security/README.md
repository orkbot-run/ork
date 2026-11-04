# Security

Audit-event mapping, audit exports, CSP reports, and secret-migration storage access live here, preparing security records and enforcing limits on incoming CSP reports. Authentication and encryption primitives remain in workspace packages.

Use `createAuthResponseAudit` and `procedureSecurityEvent` for audit integration, `mountAuditExportRoute` and `cspReportRoutes` for HTTP handlers, and `createSecretMigrationRepository` from maintenance commands. Domain services retain authorization checks for their own operations.
