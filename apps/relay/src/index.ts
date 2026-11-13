// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { accountsRedeemer } from "./redeem.js";
import { InstallationRelay } from "./relay.js";

const issuer = process.env.ORK_ACCOUNTS_ISSUER?.trim();
const origin = process.env.ORK_RELAY_ORIGIN?.trim();
if (!issuer || !origin) throw new Error("Set ORK_ACCOUNTS_ISSUER and ORK_RELAY_ORIGIN");
const port = Number(process.env.PORT ?? "3210");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid relay port");
const relay = new InstallationRelay({ origin, redeem: accountsRedeemer(issuer, origin) });
relay.server.listen(port, process.env.HOST ?? "0.0.0.0");
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  void relay.close().then(() => {
    clearTimeout(deadline);
    process.exitCode = 0;
  });
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
