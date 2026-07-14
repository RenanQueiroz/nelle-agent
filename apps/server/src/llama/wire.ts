/**
 * The wire helpers: reading llama.cpp's JSON and its SSE stream.
 *
 * llama.cpp's router answers free-form JSON — fields appear, disappear, and change case between
 * builds — so **every read is a coercion, not a cast.** `getProp` walks an `unknown` safely and the
 * coercers turn whatever came back into something typed, or into a null the caller must handle.
 * That is why nothing here throws: a missing field is a missing detail, never a failed turn.
 *
 * Shared by the router client and the load orchestrator, which is why it is its own module — without
 * it, either one drags the other in.
 */

export function getProp(value: unknown, key: string): unknown {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function booleanOrFalse(value: unknown): boolean {
  return value === true;
}

/** A frame llama.cpp sent that will not parse is a missing detail, never a thrown run. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function routerExitCode(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const status = (raw as {status?: unknown}).status;
  if (!status || typeof status !== 'object') {
    return null;
  }
  const exitCode = (status as {exit_code?: unknown}).exit_code;
  return typeof exitCode === 'number' ? exitCode : null;
}

/** Yields the payload of each `data:` line in an SSE stream. */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) {
          yield line.slice('data:'.length).trim();
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
