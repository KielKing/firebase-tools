import RetriesExhaustedError from "../../../throttler/errors/retries-exhausted-error";
import PQueue, { Options, QueueAddOptions } from "p-queue";
import PriorityQueue from "p-queue/dist/priority-queue";
import { Queue } from "../../../throttler/queue";
import { ThrottlerOptions } from "../../../throttler/throttler";

/**
 * An Executor runs lambdas (which may be async).
 */
export interface Executor {
  run<T>(func: () => Promise<T>, opts?: RunOptions): Promise<T>;
}

export interface RunOptions {
  retryCodes?: number[];
}

export interface RateLimitedOptions extends Options<PriorityQueue, QueueAddOptions> {
  retries: number;
}

interface Operation {
  func: () => any;
  retryCodes: number[];
  result?: any;
  error?: any;
}

interface RateLimitedOperation extends Operation {
  retryCount: number;
}

export const DEFAULT_RETRY_CODES = [429, 409, 503];

function parseErrorCode(err: any): number {
  return (
    err.status ||
    err.code ||
    err.context?.response?.statusCode ||
    err.original?.code ||
    err.original?.context?.response?.statusCode
  );
}

async function handler(op: Operation): Promise<void> {
  try {
    op.result = await op.func();
  } catch (err: any) {
    // Throw retry functions back to the queue where they will be retried
    // with backoffs. To do this we cast a wide net for possible error codes.
    // These can be either TOO MANY REQUESTS (429) errors or CONFLICT (409)
    // errors. This can be a raw error with the correct HTTP code, a raw
    // error with the HTTP code stashed where GCP puts it, or a FirebaseError
    // wrapping either of the previous two cases.
    const code = parseErrorCode(err);
    if (op.retryCodes.includes(code)) {
      throw err;
    }
    err.code = code;
    op.error = err;
  }
  return;
}

/**
 * A QueueExecutor implements the executor interface on top of a throttler queue.
 * Any 429 will be retried within the ThrottlerOptions parameters, but all
 * other errors are rethrown.
 */
export class QueueExecutor implements Executor {
  private readonly queue: Queue<Operation, void>;
  constructor(options: Omit<ThrottlerOptions<Operation, void>, "handler">) {
    this.queue = new Queue({ ...options, handler });
  }

  async run<T>(func: () => Promise<T>, opts?: RunOptions): Promise<T> {
    const retryCodes = opts?.retryCodes || DEFAULT_RETRY_CODES;

    const op: Operation = {
      func,
      retryCodes,
    };
    await this.queue.run(op);
    if (op.error) {
      throw op.error;
    }
    return op.result as T;
  }
}

export class RateLimitedExecutor implements Executor {
  private readonly queue: PQueue;
  private readonly retries: number;

  constructor(options: RateLimitedOptions) {
    this.queue = new PQueue(options);
    this.retries = options.retries;
  }

  async run<T>(func: () => Promise<T>, opts?: RunOptions): Promise<T> {
    const retryCodes = opts?.retryCodes || DEFAULT_RETRY_CODES;

    const op: RateLimitedOperation = {
      func,
      retryCodes,
      retryCount: 0,
    };
    const task = (): Promise<void> => {
      try {
        return handler(op);
      } catch (err: any) {
        if (op.retryCount > this.retries) {
          throw new RetriesExhaustedError("rateLimitedExecutor", this.retries, err);
        }

        op.retryCount++;
        return this.queue.add(task);
      }
    };
    await this.queue.add(task);
    if (op.error) {
      throw op.error;
    }
    return op.result as T;
  }
}

/**
 * Inline executors run their functions right away.
 * Useful for testing.
 */
export class InlineExecutor {
  run<T>(func: () => Promise<T>): Promise<T> {
    return func();
  }
}
