export function compatibleModelLimits(model: string): { contextWindow: number; maxTokens: number } {
  // DeepSeek V4.1 Flash (the configured Arkive model) supports the larger limits.
  // Keep unknown OpenAI-compatible providers conservative until their limits are verified.
  if (/deepseek[-_. ]v?4(?:\.1)?[-_. ]flash|deepseek[-_. ]flash/i.test(model))
    return { contextWindow: 1_000_000, maxTokens: 384_000 }
  return { contextWindow: 32_768, maxTokens: 4096 }
}
