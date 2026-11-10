import { GoogleServiceError } from './google-http.ts';
import type { GoogleRequestOptions } from './google-http';

export interface BudgetOptions extends GoogleRequestOptions {
    workTimeoutMs?: number;
}

/**
 * Share a single deadline and cancellation signal across a server operation's external calls.
 *
 * @param options - Overall work limit and per-call timeout in milliseconds, plus caller cancellation.
 * @param run - Obtain fresh connection options before each external call to apply the remaining time.
 */
export async function withRequestBudget<T>(
    options: BudgetOptions,
    run: (scope: {
        connection: () => GoogleRequestOptions;
        remainingMs: () => number;
    }) => Promise<T>,
): Promise<T> {
    const timeout = options.workTimeoutMs ?? 25000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 25000)
        throw new GoogleServiceError(500, 'INTERNAL_ERROR', false);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const end = performance.now() + timeout;
    let stopped = false;
    const remainingMs = () => {
        const remaining = Math.ceil(end - performance.now());
        if (stopped || controller.signal.aborted || remaining <= 0)
            throw new GoogleServiceError(504, 'TIMEOUT', true);
        return remaining;
    };
    const connection = () => ({
        apiKey: options.apiKey,
        mapsAuthentication: options.mapsAuthentication,
        vertexAuthentication: options.vertexAuthentication,
        fetch: options.fetch,
        timeoutMs: Math.min(options.timeoutMs ?? 5000, remainingMs()),
        signal: controller.signal,
    });
    let timer: ReturnType<typeof setTimeout>;
    const limit = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new GoogleServiceError(504, 'TIMEOUT', true));
        }, timeout);
    });
    try {
        remainingMs();
        return await Promise.race([run({ connection, remainingMs }), limit]);
    } finally {
        stopped = true;
        clearTimeout(timer!);
        controller.abort();
        options.signal?.removeEventListener('abort', abort);
    }
}
