/**
 * Local OpenAI-compatible model server (Ollama, LM Studio, llama.cpp, MLX).
 * Kept apart from pi-local-provider.ts so the runtime limits can name it without loading the provider.
 */
export const LOCAL_PROVIDER_ID = "local";

/** The operator has confirmed that the server does not reuse cached prompts. */
export function localPromptCacheDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORKBOT_LOCAL_PROMPT_CACHE?.trim().toLowerCase() === "off";
}

export function localInputTokensPerMinute(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const limit = Number(env.ORKBOT_LOCAL_TOKENS_PER_MINUTE);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/** Comma-separated model ids exactly as the local server names them. */
export function localModelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ORKBOT_LOCAL_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
