import {z} from 'zod';

import {attachmentSetting, resolveChatAttachments} from '../attachments/ingest';
import {chatRequestSchema} from '../contracts/contracts.ts';
import {MAX_IMAGE_MEGAPIXELS_KEY} from '../contracts/settingsKeys.ts';
import {resolveConversationModel} from '../conversations/model';
import type {Router} from '../http/router';
import {sseResponse, writeChatError, writeChatEvent, writeChatStream} from '../http/sse';
import type {ChatAttachmentInput, ChatStreamEvent} from '../lib/types';
import {effectiveContextWindow} from '../llama/contextWindow';
import {ensureModelReadyForRun} from '../llama/modelReady';
import type {PiHarness} from '../pi/harness';
import {conversationNotFound} from './conversations';
import type {RouteDeps} from './deps';
import {
  assertRuntimeRunning,
  assertSupportedAttachments,
  assertSupportedSlashCommand,
} from './guards';

const regenerateMessageSchema = z
  .object({
    modelId: z.string().min(1).optional(),
  })
  .optional();

/**
 * The two routes that produce a run, and the only two that load a model.
 *
 * They are registered as two functions rather than one because **registration order is
 * match order**, and these two have never been adjacent: the uploads routes sit between
 * them. Preserving that exactly is what keeps the router\'s route table -- and the path
 * order of the served OpenAPI document -- byte-identical across this split.
 */
export function registerChatStreamRoute(router: Router, deps: RouteDeps): void {
  const {store, conversations, settings, modelCache, ggufMetadata, uploads, llama, pi, log} = deps;

  router.post('/api/conversations/:id/chat/stream', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    // Parsed above the stream, so a schema failure is an ordinary 400 rather than
    // an SSE error event a browser has to special-case.
    const body = chatRequestSchema.parse(await ctx.body());
    return sseResponse(async sink => {
      try {
        // Enforced in the browser composer too. Enforcing them only there leaves
        // every non-browser client able to post an image to a text-only model, or
        // hand Pi `/model` as a literal prompt.
        assertSupportedSlashCommand(body.message);
        await assertRuntimeRunning(llama);

        // Load the model this conversation will actually answer with (piHarness
        // resolves the same way), or the run loads one model and answers with another.
        const activeModel = await resolveConversationModel(conversations, store, id);
        if (activeModel) {
          await ensureModelReadyForRun({
            llama,
            modelCache,
            ggufMetadata,
            conversationId: id,
            modelId: activeModel.id,
            write: event => writeChatEvent(sink, event, id),
            log,
          });
        }
        // The client references uploads; the server turns them into what the
        // harness reads, deciding for each PDF whether to send its text or its
        // pages. The per-message limits are checked after that expansion, because a
        // six-page scan is six attachments. Runs after the load, so `model_cache`
        // can answer whether the model sees images.
        const resolved = await resolveChatAttachments(
          uploads,
          body.attachments ?? [],
          {
            // llama.cpp's answer if it has one, else the configured cap, else
            // `null` -- which skips the pre-flight rather than refusing on a guess.
            contextSize: activeModel ? effectiveContextWindow(activeModel, modelCache) : null,
            visionSupport: activeModel ? modelCache.getVisionSupport(activeModel.id) : null,
          },
          {maxImageMegapixels: attachmentSetting(settings, MAX_IMAGE_MEGAPIXELS_KEY)},
        );
        // The model that will *answer* -- the same one `resolveChatAttachments` just
        // gated against. This used to re-check against `state.activeModelId`, the
        // global default, so a chat pinned to a vision model had its images refused
        // whenever some other model happened to be globally active.
        assertSupportedAttachments(resolved.attachments, modelCache, activeModel?.id ?? null);
        for (const reference of body.attachments ?? []) {
          uploads.markBound(reference.uploadId);
        }

        const stream = await createChatStream({
          pi,
          conversationId: id,
          message: body.message,
          attachments: resolved.attachments,
        });
        await writeChatStream(sink, stream, id);
      } catch (error) {
        writeChatError(sink, error);
      }
    });
  });
}

/**
 * Regenerating an answer -- a run like any other, and registered *after* the uploads routes
 * because that is where it has always been in the sequence.
 */
export function registerRegenerateRoute(router: Router, deps: RouteDeps): void {
  const {store, conversations, modelCache, ggufMetadata, llama, pi, log} = deps;

  router.post('/api/conversations/:id/messages/:messageId/regenerate', async ctx => {
    const {id, messageId} = ctx.params;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = regenerateMessageSchema.parse(await ctx.body()) ?? {};
    return sseResponse(async sink => {
      try {
        if (process.env.NELLE_PI_DISABLED === '1') {
          throw new Error('Regeneration requires the Pi harness.');
        }
        await assertRuntimeRunning(llama);
        // An explicit override wins (that is what a footer model change is);
        // otherwise regenerate on the conversation's own model.
        const regenerateModel = body.modelId
          ? await store.getModel(body.modelId)
          : await resolveConversationModel(conversations, store, id);
        if (regenerateModel) {
          await ensureModelReadyForRun({
            llama,
            modelCache,
            ggufMetadata,
            conversationId: id,
            modelId: regenerateModel.id,
            write: event => writeChatEvent(sink, event, id),
            log,
          });
        }
        const stream = await pi.regenerateMessage({
          conversationId: id,
          assistantMessageId: messageId,
          modelId: body.modelId,
        });
        await writeChatStream(sink, stream, id);
      } catch (error) {
        writeChatError(sink, error);
      }
    });
  });
}

/**
 * The chat stream. **Pi is the only path.**
 *
 * There used to be a "direct llama.cpp fallback" here, and it was not one: it ran only when
 * `NELLE_PI_DISABLED=1` (an env var nothing in the server or the scripts ever set -- only a test)
 * *and* the conversation was `legacy-default`, which only the retired migration ever created. It was
 * unreachable in production, untested end to end, and supported no tools, no reasoning, no
 * compaction and no regenerate. `README` promised it as a real capability; that sentence was false.
 *
 * A Pi failure surfaces as a coded stream error the client renders. That **is** the graceful
 * degradation. A second, permanently second-class chat engine that never runs is not a safety net --
 * it is the least-tested code in the repository, waiting to execute at the worst possible moment.
 */
async function createChatStream(input: {
  pi: PiHarness;
  conversationId: string;
  message: string;
  attachments: ChatAttachmentInput[];
}): Promise<AsyncIterable<ChatStreamEvent>> {
  return input.pi.streamPrompt(input.message, input.conversationId, input.attachments);
}
