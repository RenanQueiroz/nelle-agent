export type AsyncQueue<T> = AsyncIterable<T> & {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
};

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  let ended = false;
  let failure: unknown = null;
  let notify: (() => void) | null = null;

  const wait = () =>
    new Promise<void>(resolve => {
      notify = resolve;
    });

  const wake = () => {
    const resolve = notify;
    notify = null;
    resolve?.();
  };

  return {
    push(value: T) {
      values.push(value);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
    fail(error: unknown) {
      failure = error;
      ended = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      while (!ended || values.length > 0) {
        if (values.length > 0) {
          yield values.shift() as T;
          continue;
        }
        await wait();
      }
      if (failure) {
        throw failure;
      }
    },
  };
}
