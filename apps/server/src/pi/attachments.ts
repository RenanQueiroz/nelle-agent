/**
 * What a prompt carries besides its text: the bytes, where they land, and how they reach Pi.
 *
 * A text attachment becomes an `<attachment>` block appended to the prompt; an image becomes a
 * structured image input, and is refused outright for a model llama.cpp has *proven* cannot see.
 * Sent bytes land content-addressed under `.nelle/attachments/`, keyed by sha256, so the same
 * file attached twice is stored once.
 *
 * Everything it needs arrives through the constructor -- the data directory, the repository the
 * rows go into, and the two llama.cpp facts the image pre-flight asks for. It holds none of the
 * harness's run state.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {AttachmentMetadata} from '../contracts/conversations.ts';
import type {ChatAttachmentInput} from '../contracts/contracts.ts';
import type {ConversationRepository} from '../conversations/repository';
import type {AppPaths} from '../lib/paths';
import type {LlamaModelProps} from '../lib/types';
import type {ModelCacheRepository} from '../models/cache';
import {llamaRuntimeModelId} from '../models/compat';
import type {ConfiguredModel} from '../lib/types';

const ATTACHMENT_TEXT_INLINE_MAX = 200_000;

export type PreparedPromptAttachment = {
  input: ChatAttachmentInput;
  metadata: AttachmentMetadata;
  text?: string;
  image?: {
    type: 'image';
    data: string;
    mimeType: string;
  };
};

export type PreparedPromptAttachments = {
  items: PreparedPromptAttachment[];
  metadata: AttachmentMetadata[];
  uploadIds: string[];
};

export class PiAttachments {
  constructor(
    private readonly paths: AppPaths,
    private readonly conversations: ConversationRepository,
    /**
     * Only `getModelProps` is asked for here: the image pre-flight is the one thing in this
     * cluster that has a question for llama.cpp.
     */
    private readonly llamaRuntime?: {
      getModelProps?: (modelId: string) => Promise<LlamaModelProps>;
    },
    private readonly modelCache?: ModelCacheRepository,
  ) {}

  async preparePromptAttachments(
    conversationId: string,
    attachments: ChatAttachmentInput[],
    activeModel: ConfiguredModel,
  ): Promise<PreparedPromptAttachments> {
    if (attachments.length === 0) {
      return emptyPreparedAttachments();
    }
    if (attachments.some(attachment => attachment.kind === 'image')) {
      await this.assertImageAttachmentsSupported(activeModel);
    }

    await fs.mkdir(this.paths.attachmentsDir, {recursive: true});
    const records = [];
    const prepared: Array<Omit<PreparedPromptAttachment, 'metadata'>> = [];
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        const image = decodeImageAttachment(attachment);
        const storagePath = await this.writeAttachmentBlob(image.buffer, image.mimeType);
        records.push({
          uploadId: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: image.mimeType,
          sizeBytes: attachment.sizeBytes ?? image.buffer.byteLength,
          storagePath,
          processing: {
            status: 'ready',
            source: 'chat-request',
            sha256: image.sha256,
          },
        });
        prepared.push({
          input: attachment,
          image: {
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
          },
        });
        continue;
      }

      const text = (attachment.text ?? '').slice(0, ATTACHMENT_TEXT_INLINE_MAX);
      records.push({
        uploadId: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        textContent: text,
        processing: {
          status: 'ready',
          source: 'chat-request',
          truncated: (attachment.text?.length ?? 0) > text.length,
        },
      });
      prepared.push({
        input: attachment,
        text,
      });
    }

    const metadata = this.conversations.createPendingAttachments(conversationId, records);
    return {
      items: prepared.map((item, index) => ({
        ...item,
        metadata: metadata[index]!,
      })),
      metadata,
      uploadIds: attachments.map(attachment => attachment.id),
    };
  }

  /**
   * Refuses image attachments for a model that cannot see them.
   *
   * This used to `fetch` llama.cpp `/props` directly, behind the back of both the
   * `/api/llama` facade and `model_cache` -- a third implementation of a question
   * the cache exists to answer. It now asks the facade and records the answer, so
   * a later reader does not have to ask llama.cpp again.
   *
   * The behavior is unchanged: props that cannot be fetched are still an error,
   * because llama.cpp only answers for a model it has loaded at least once. Once
   * the server loads models itself, this whole method gives way to
   * `modelCache.getVisionSupport()`.
   */
  async assertImageAttachmentsSupported(activeModel: ConfiguredModel): Promise<void> {
    const llamaRuntime = this.llamaRuntime;
    if (!llamaRuntime?.getModelProps) {
      throw new Error(
        'Could not verify image support for the selected model. Load the model before sending images.',
      );
    }

    let props: LlamaModelProps;
    try {
      // Called on the manager, not detached from it: `getModelProps` reaches for
      // `this.fetchRouterJson`, and an unbound call fails as if llama.cpp were
      // unreachable.
      props = await llamaRuntime.getModelProps(llamaRuntimeModelId(activeModel));
    } catch {
      throw new Error(
        'Could not verify image support for the selected model. Load the model before sending images.',
      );
    }

    this.modelCache?.upsertModelProps(activeModel.id, props);
    if (!props.modalities.vision) {
      throw new Error('Image attachments require a selected model with vision support.');
    }
  }

  private async writeAttachmentBlob(buffer: Buffer, mimeType: string): Promise<string> {
    const sha256 = new Bun.CryptoHasher('sha256').update(buffer).digest('hex');
    const directory = path.join(this.paths.attachmentsDir, sha256.slice(0, 2));
    await fs.mkdir(directory, {recursive: true});
    const absolutePath = path.join(directory, `${sha256}${extensionForMimeType(mimeType)}`);
    try {
      await fs.writeFile(absolutePath, buffer, {flag: 'wx'});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    return relativeDataPath(this.paths.dataDir, absolutePath);
  }

  async loadAttachmentInputsForEntry(
    conversationId: string,
    piEntryId: string,
  ): Promise<ChatAttachmentInput[]> {
    const stored = this.conversations.getStoredAttachmentsForEntry(conversationId, piEntryId);
    const inputs: ChatAttachmentInput[] = [];
    for (const attachment of stored) {
      if (attachment.kind === 'image') {
        if (!attachment.storagePath || !attachment.mimeType) {
          continue;
        }
        const absolutePath = resolveDataPath(this.paths.dataDir, attachment.storagePath);
        const buffer = await fs.readFile(absolutePath);
        inputs.push({
          id: crypto.randomUUID(),
          kind: 'image',
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes ?? buffer.byteLength,
          data: buffer.toString('base64'),
        });
        continue;
      }
      if (!attachment.textContent) {
        continue;
      }
      inputs.push({
        id: crypto.randomUUID(),
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        text: attachment.textContent,
      });
    }
    return inputs;
  }
}

export function emptyPreparedAttachments(): PreparedPromptAttachments {
  return {items: [], metadata: [], uploadIds: []};
}

export function buildPiPrompt(prompt: string, attachments: PreparedPromptAttachment[]): string {
  const textAttachments = attachments.filter(item => item.text);
  if (textAttachments.length === 0) {
    return prompt;
  }
  const renderedAttachments = textAttachments
    .map(
      attachment =>
        `<attachment name="${escapeAttachmentAttribute(attachment.metadata.name)}" type="${
          attachment.metadata.kind
        }">\n${attachment.text}\n</attachment>`,
    )
    .join('\n\n');
  return `${prompt}\n\nAttached files:\n${renderedAttachments}`;
}

export function summarizePreparedAttachments(attachments: AttachmentMetadata[]): unknown {
  if (attachments.length === 0) {
    return undefined;
  }
  return {
    count: attachments.length,
    items: attachments.map(attachment => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  };
}

function decodeImageAttachment(attachment: ChatAttachmentInput): {
  data: string;
  mimeType: string;
  buffer: Buffer;
  sha256: string;
} {
  const parsed = parseImageData(attachment.data ?? '', attachment.mimeType);
  const buffer = Buffer.from(parsed.data, 'base64');
  const sha256 = new Bun.CryptoHasher('sha256').update(buffer).digest('hex');
  return {...parsed, buffer, sha256};
}

function parseImageData(
  value: string,
  fallbackMimeType?: string,
): {data: string; mimeType: string} {
  const dataUrlMatch = value.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {mimeType: dataUrlMatch[1]!, data: dataUrlMatch[2]!};
  }
  if (!fallbackMimeType?.startsWith('image/')) {
    throw new Error('Image attachments require an image MIME type.');
  }
  return {mimeType: fallbackMimeType, data: value};
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/png') {
    return '.png';
  }
  if (mimeType === 'image/webp') {
    return '.webp';
  }
  if (mimeType === 'image/gif') {
    return '.gif';
  }
  return '.jpg';
}

function relativeDataPath(dataDir: string, absolutePath: string): string {
  return path.relative(dataDir, absolutePath).split(path.sep).join('/');
}

function resolveDataPath(dataDir: string, relativePath: string): string {
  const resolved = path.resolve(dataDir, ...relativePath.split('/'));
  const normalizedDataDir = path.resolve(dataDir);
  if (resolved !== normalizedDataDir && !resolved.startsWith(`${normalizedDataDir}${path.sep}`)) {
    throw new Error('Attachment path escaped the Nelle data directory.');
  }
  return resolved;
}

function escapeAttachmentAttribute(value: string): string {
  return value.replace(/[<&"]/g, character => {
    if (character === '<') {
      return '&lt;';
    }
    if (character === '&') {
      return '&amp;';
    }
    return '&quot;';
  });
}
