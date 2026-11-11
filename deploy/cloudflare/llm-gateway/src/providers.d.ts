export interface Provider {
  name: string;
  baseUrl: string;
  path?: string;
  keyVar?: string;
  modelVar?: string;
  models: string[];
  keyless?: boolean;
  freeOnly?: boolean;
}
export interface FallbackModel {
  name: string;
  url: string;
  key: string;
  model: string;
  keyless: boolean;
}
export declare const PROVIDERS: Provider[];
export declare function reasoningFor(effort: string | undefined, model: string): string | undefined;
export declare function configured(env: Record<string, unknown>): FallbackModel[];
export declare function summary(list: FallbackModel[]): { name: string; keyless: boolean; models: string[] }[];
export declare function fallback(
  list: FallbackModel[],
  request: { messages: unknown[]; max_tokens: number; tools?: unknown[]; temperature?: number; reasoning_effort?: string },
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ provider: string; model: string; body: any }>;
