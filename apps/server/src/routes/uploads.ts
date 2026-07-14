import {attachmentSetting, ingestUpload, UnsupportedAttachmentError} from '../attachments/ingest';
import {ATTACHMENT_LIMITS} from '../contracts/attachments.ts';
import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import type {NelleError, UploadResponse} from '../contracts/contracts.ts';
import {MAX_IMAGE_MEGAPIXELS_KEY} from '../contracts/settingsKeys.ts';
import {resolveConversationModel} from '../conversations/model';
import {json, type Router} from '../http/router';
import type {RouteDeps} from './deps';

/**
 * Draft attachments: uploaded, never embedded.
 *
 * The bytes go here the moment a file is staged, and the chat request that follows
 * references `{uploadId}` and nothing else. An image is refused when the file is *chosen*
 * rather than when the message is sent -- and refused against the **conversation's** model,
 * which is what will answer, not the global default.
 */
export function registerUploadRoutes(router: Router, deps: RouteDeps): void {
  const {store, conversations, settings, modelCache, uploads} = deps;

  /**
   * Draft attachments. The client posts bytes; the server classifies them,
   * extracts PDF text, and rejects what no model here can read. The message that
   * follows references the upload by id.
   */
  router.post('/api/uploads', async ctx => {
    const form = await ctx.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return json(
        {error: {code: NELLE_ERROR_CODES.invalidRequest, message: 'Attach a file to upload.'}},
        400,
      );
    }
    if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.unsupportedAttachment,
            message: `Attachments are limited to ${Math.round(ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024))} MiB per file.`,
            retryable: false,
          },
        },
        413,
      );
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const conversationId = stringField(form.get('conversationId'));
    // `req.formData()` appends `;charset=utf-8` to text types; the pipeline wants
    // the bare mime type, which is what `@fastify/multipart` gave it.
    const mimeType = (file.type || 'application/octet-stream').split(';')[0]!.trim();
    let ingested;
    try {
      ingested = await ingestUpload({
        name: file.name,
        mimeType,
        bytes,
        maxImageMegapixels: attachmentSetting(settings, MAX_IMAGE_MEGAPIXELS_KEY),
      });
    } catch (error) {
      return json({error: unsupportedAttachmentError(error)}, 400);
    }

    // Refused when the file is chosen, not when the message is sent. `null` means
    // llama.cpp has never reported props, so the model is unproven rather than
    // proven text-only; the client keeps its own conservative UI gate.
    //
    // Gated against the **conversation's** model, which is what will answer -- the form
    // has carried `conversationId` all along. Reading the global `activeModelId` here
    // refused an image for a chat pinned to a vision model whenever some other model was
    // globally active, and accepted one the answering model could not see.
    const uploadModel = conversationId
      ? await resolveConversationModel(conversations, store, conversationId)
      : await store.getActiveModel();
    const visionSupport = uploadModel ? modelCache.getVisionSupport(uploadModel.id) : null;
    // A PDF with no text layer is a scan: page images are the only way to read it.
    const isScan = ingested.kind === 'pdf' && !ingested.textContent;
    if (visionSupport === false && (ingested.kind === 'image' || isScan)) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.unsupportedAttachment,
            message: isScan
              ? `${ingested.name} has no text layer, so it can only be read as page images, and the selected model cannot read images. Choose a vision model.`
              : 'The selected model cannot read images. Choose a vision model, or attach a text or PDF file.',
          },
        },
        400,
      );
    }

    const upload = await uploads.create({
      conversationId,
      kind: ingested.kind,
      name: ingested.name,
      mimeType: ingested.mimeType,
      bytes: ingested.bytes,
      textContent: ingested.textContent,
      pageCount: ingested.pageCount,
    });
    // Typed through the contract, so the body and the schema a client codegens from
    // cannot drift apart.
    const body: UploadResponse = {
      uploadId: upload.id,
      kind: upload.kind,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      textPreview: ingested.textContent?.slice(0, 500),
      pageCount: ingested.pageCount,
      /** PDFs only. `false` means a scan, which reaches the model as page images. */
      hasTextLayer: ingested.kind === 'pdf' ? Boolean(ingested.textContent) : undefined,
      warnings: ingested.warnings,
    };
    return json(body, 201);
  });

  router.get('/api/uploads/:uploadId', async ctx => {
    const upload = uploads.get(ctx.params.uploadId);
    if (!upload) {
      return json({error: {code: NELLE_ERROR_CODES.notFound, message: 'Upload not found.'}}, 404);
    }
    return json({
      uploadId: upload.id,
      kind: upload.kind,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      text: upload.textContent,
      createdAt: upload.createdAt,
      bound: Boolean(upload.boundAt),
    });
  });

  router.delete('/api/uploads/:uploadId', async ctx => {
    const deleted = await uploads.deleteUnbound(ctx.params.uploadId);
    if (!deleted) {
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'No unsent upload with that id.'}},
        404,
      );
    }
    return json({ok: true});
  });
}

/** Multipart text fields arrive as strings under `req.formData()`. */
function stringField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unsupportedAttachmentError(error: unknown): NelleError {
  return {
    code: NELLE_ERROR_CODES.unsupportedAttachment,
    message:
      error instanceof UnsupportedAttachmentError || error instanceof Error
        ? error.message
        : 'The attachment could not be read.',
    retryable: false,
  };
}
