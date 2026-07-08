import {z} from 'zod';

export const nelleErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  detail: z.string().optional(),
  retryable: z.boolean().optional(),
  logRef: z.string().optional(),
});

export type NelleError = z.infer<typeof nelleErrorSchema>;

export const eventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  createdAt: z.string().datetime(),
  data: z.unknown(),
});

export type NelleEventEnvelope<TType extends string = string, TData = unknown> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  'type' | 'data'
> & {
  type: TType;
  data: TData;
};

export function createEventEnvelope<TType extends string, TData>(
  input: Omit<NelleEventEnvelope<TType, TData>, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: string;
  },
): NelleEventEnvelope<TType, TData> {
  return {
    id: input.id ?? createMonotonicEventId(),
    type: input.type,
    conversationId: input.conversationId,
    runId: input.runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    data: input.data,
  };
}

export function serializeSseEnvelope(envelope: NelleEventEnvelope): string {
  const event = sanitizeSseField(envelope.type);
  const id = sanitizeSseField(envelope.id);
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

let lastEventMilliseconds = 0;
let lastEventSequence = 0;

function createMonotonicEventId(): string {
  const now = Date.now();
  if (now === lastEventMilliseconds) {
    lastEventSequence += 1;
  } else {
    lastEventMilliseconds = now;
    lastEventSequence = 0;
  }
  return `${now.toString(36)}-${lastEventSequence.toString(36).padStart(4, '0')}`;
}

function sanitizeSseField(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}
