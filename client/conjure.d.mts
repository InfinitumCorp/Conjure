// Types for conjure.mjs (Conjure™ client for Infinitum products).
export declare const CONJURE_CLIENT_VERSION: string;

export declare class ConjureApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown);
}

export interface ConjureMention { question: string; context: string }

export interface ConjureReport {
  outcome: string;
  probability: number;
  forecast: string;
  drivers: string[];
  signals: string[];
  assumptions: string[];
  confidence: "low" | "medium" | "high";
}

export interface LivePrediction {
  id: string;
  product: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  question: string;
  round: number;
  rounds: number;
  agents: number;
  poles?: { for: string; against: string };
  stats: { round: number; meanStance: number; split: { for: number; against: number; undecided: number } }[];
  report?: ConjureReport;
  error?: string;
  mode?: "live" | "mock";
  createdAt: string;
  finishedAt?: string;
}

export interface PredictOptions {
  context?: string;
  user?: string;
  source?: string;
  agents?: number;
  rounds?: number;
}

export declare function parseConjureMention(text: unknown): ConjureMention | null;
export declare function hasConjureMention(text: unknown): boolean;
export declare function formatForecast(prediction: Partial<LivePrediction> | null | undefined): string;

export interface ConjureClient {
  health(signal?: AbortSignal): Promise<{ ok: boolean; product: string; live: boolean }>;
  start(options: PredictOptions & { question: string }, signal?: AbortSignal): Promise<LivePrediction>;
  get(id: string, signal?: AbortSignal): Promise<LivePrediction>;
  list(signal?: AbortSignal): Promise<LivePrediction[]>;
  interview(id: string, agentId: string, question: string, signal?: AbortSignal): Promise<{ answer: string }>;
  cancel(id: string, signal?: AbortSignal): Promise<{ cancelled: boolean }>;
  wait(id: string, options?: { onProgress?: (p: LivePrediction) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<LivePrediction>;
  predict(question: string, options?: PredictOptions & { onProgress?: (p: LivePrediction) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<LivePrediction>;
  handleMention(text: string, options?: PredictOptions & { wait?: boolean; onProgress?: (p: LivePrediction) => void; signal?: AbortSignal }): Promise<{ prediction: LivePrediction | null; text: string } | null>;
}

export declare function createConjure(options: { url: string; key: string; fetch?: typeof fetch; timeoutMs?: number; pollMs?: number }): ConjureClient;
export type ConjureRouteHandler = (request: Request, who: { user?: string | null; context?: string }) => Promise<Response | null>;
export declare function createConjureRoutes(options: { conjure: ConjureClient | null; secret: string; prefix?: string; source?: string }): ConjureRouteHandler;
export declare function toWebRequest(req: AsyncIterable<Uint8Array> & { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, base?: string): Promise<Request>;
export declare function sendWebResponse(res: { writeHead(status: number, headers: Record<string, string>): unknown; end(body: Uint8Array): unknown }, response: Response): Promise<void>;
export declare function conjureFromEnv(env?: Record<string, string | undefined>): ConjureClient | null;
export declare function conjureRoutesFromEnv(env?: Record<string, string | undefined>, options?: { prefix?: string; source?: string }): ConjureRouteHandler;
