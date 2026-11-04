import { waitForModelOAuthCompletion } from "@orkbot/core";
import type { RpcClient } from "./rpc";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@orkbot/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@orkbot/core";

/** `client` must be the one that began the sign-in: the login belongs to its space. */
export async function waitForModelOAuth(
  loginId: string,
  signal?: AbortSignal,
  client: RpcClient = rpc,
) {
  return waitForModelOAuthCompletion(() => client.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
