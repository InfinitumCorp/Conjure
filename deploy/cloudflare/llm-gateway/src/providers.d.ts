export interface Provider {
  name: string;
  baseUrl: string;
  keyVar: string;
  modelVar: string;
  model: string;
  reasoning(effort: string | undefined, model: string): string | undefined;
  freeOnly?: boolean;
}
export declare const PROVIDERS: Provider[];
export declare function configured(env: Record<string, unknown>): (Provider & { key: string })[];
export declare function fallback(
  providers: (Provider & { key: string })[],
  request: { messages: unknown[]; max_tokens: number; tools?: unknown[]; temperature?: number; reasoning_effort?: string },
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ provider: string; model: string; body: any }>;
