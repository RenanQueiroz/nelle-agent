/**
 * A minimal, valid GGUF header with no tensors.
 *
 * Hand-built rather than committed as a binary fixture, for the same reason the
 * PDF helpers are: the byte offsets stay correct when the values change, and the
 * test reads as data rather than as a blob.
 *
 * Layout (`ggml/docs/gguf.md`): magic `GGUF`, version u32, tensor count u64,
 * metadata count u64, then each key-value as `len:u64 bytes`, `type:u32`, value.
 */
const GGUF_TYPE_UINT32 = 4;
const GGUF_TYPE_STRING = 8;

type GgufValue = {type: 'string'; value: string} | {type: 'uint32'; value: number};

export function ggufHeaderBuffer(entries: Record<string, GgufValue>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(4 + 4 + 8 + 8);
  header.write('GGUF', 0, 'ascii');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(0n, 8); // tensor_count
  header.writeBigUInt64LE(BigInt(Object.keys(entries).length), 16);
  parts.push(header);

  for (const [key, entry] of Object.entries(entries)) {
    parts.push(ggufString(key));
    const type = Buffer.alloc(4);
    if (entry.type === 'string') {
      type.writeUInt32LE(GGUF_TYPE_STRING, 0);
      parts.push(type, ggufString(entry.value));
    } else {
      type.writeUInt32LE(GGUF_TYPE_UINT32, 0);
      const value = Buffer.alloc(4);
      value.writeUInt32LE(entry.value, 0);
      parts.push(type, value);
    }
  }
  return Buffer.concat(parts);
}

/** A model whose architecture namespaces its own `context_length` key. */
export function minimalGgufBuffer(
  input: {architecture: string; contextLength: number; parameterCount?: number} = {
    architecture: 'testarch',
    contextLength: 4096,
  },
): Buffer {
  const entries: Record<string, GgufValue> = {
    'general.architecture': {type: 'string', value: input.architecture},
    [`${input.architecture}.context_length`]: {type: 'uint32', value: input.contextLength},
  };
  if (input.parameterCount != null) {
    entries['general.parameter_count'] = {type: 'uint32', value: input.parameterCount};
  }
  return ggufHeaderBuffer(entries);
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.byteLength), 0);
  return Buffer.concat([length, bytes]);
}
