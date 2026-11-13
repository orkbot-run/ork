// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Transport and service outages permit trying an already activated personal credential. */
export class AccountsUnavailable extends Error {
  constructor() {
    super("Could not reach Accounts. Try again.");
  }
}
export const fetchAccounts: typeof fetch = async (input, init) => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new AccountsUnavailable();
  }
  if (response.status >= 500) throw new AccountsUnavailable();
  return response;
};
