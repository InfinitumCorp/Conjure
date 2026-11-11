export declare const DAILY_NEURONS: number;
export declare const RATES: Record<string, [number, number]>;
export declare function neuronsFor(model: string, inputTokens: number, outputTokens: number): number;
export declare function worstCase(model: string, input?: Record<string, unknown>): number;
export declare function actualNeurons(model: string, result: unknown): number | null;
export declare class FreeAllowanceUsed extends Error {
  status: number;
}
interface LedgerNamespace {
  idFromName(name: string): unknown;
  get(id: any): any;
}
export declare function budgetedAI<T extends { run(model: string, input: any, options?: any): Promise<any> }>(
  ai: T,
  ledgerNamespace: LedgerNamespace | undefined | null,
  options?: { limit?: number; waitUntil?: (p: Promise<unknown>) => void },
): T;
