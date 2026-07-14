import {z} from 'zod';

import {
  cloneConversationRequestSchema,
  forkConversationRequestSchema,
} from '../contracts/conversations.ts';
import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import {reasoningLevelSchema} from '../contracts/reasoning.ts';
import {exportConversationArchive, importConversationArchive} from '../conversations/archive';
import {normalizeNelleError} from '../http/errors';
import {json, type Router} from '../http/router';
import {sseResponse, writeChatError, writeChatStream} from '../http/sse';
import {deleteConversationResources} from '../lib/files';
import {PiHarness, isConversationNotFoundError} from '../pi/harness';
import type {RouteDeps} from './deps';

const compactConversationSchema = z
  .object({
    instructions: z.string().max(2000).optional(),
  })
  .optional();

// Fork and clone live in `contracts/`: they are contract shapes, and a client that has
// to guess at them is a client that will guess wrong. `.optional()` on the clone body because a
// bare `POST` with no body is a whole-conversation duplicate.
const cloneConversationSchema = cloneConversationRequestSchema.optional();

const listConversationsQuerySchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const createConversationSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    defaultModelId: z.string().nullable().optional(),
  })
  .optional();

const patchConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  defaultModelId: z.string().nullable().optional(),
});

const conversationReasoningSchema = z.object({level: reasoningLevelSchema});

/**
 * A conversation's whole life except the runs: create, read, rename, pin, fork, clone,
 * export, import, delete -- and the three explicit exits an `unavailable` one recovers
 * through, which are never implicit. Repair is lossless and so is offered first; rebuild is
 * lossy and the client must say what it destroys; diagnostics says what is wrong.
 *
 * Compaction is here rather than with the chat routes because it is a conversation
 * operation -- it rewrites the history, it does not answer a prompt.
 */
export function registerConversationRoutes(router: Router, deps: RouteDeps): void {
  const {paths, store, conversations, hostTools, uploads, pi} = deps;

  router.get('/api/conversations', async ctx => {
    const query = listConversationsQuerySchema.parse(ctx.query);
    await conversations.markInvalidPiSessionsUnavailable();
    return json(conversations.listConversations(query));
  });

  router.post('/api/conversations', async ctx => {
    const body = createConversationSchema.parse(await ctx.body()) ?? {};
    const snapshot = await pi.createConversation(body);
    return json({conversation: snapshot.conversation, snapshot});
  });

  router.delete('/api/conversations', async () => {
    const resources = conversations.getAllConversationDeleteResources();
    conversations.hardDeleteAllConversations();
    hostTools.deleteAllAuditEvents();
    const cleanup = await deleteConversationResources(paths, resources);
    pi.resetSession();
    return json({ok: true, cleanup});
  });

  router.post('/api/conversations/import', async ctx => {
    const bytes = new Uint8Array(await ctx.req.arrayBuffer());
    if (bytes.length === 0) {
      return json(
        {
          error: {
            code: 'invalid_archive_upload',
            message: 'Upload a .nelle-chat.zip archive body.',
          },
        },
        400,
      );
    }
    let imported: {conversationId: string};
    try {
      imported = await importConversationArchive({paths, store, conversations, bytes});
    } catch (error) {
      // **Keep the code the archive threw.** `archive_session_missing` is a real, distinct
      // refusal -- the zip is perfectly valid, it simply carries no history, because it was
      // exported from a conversation whose Pi session file had already been lost. Flattening it
      // to `invalid_archive` told the user their file was corrupt, which it is not, and left a
      // code in `NELLE_ERROR_CODES` that nothing ever emitted: a promise the contract made and
      // never kept.
      return json(
        {error: normalizeNelleError(error, {fallbackCode: NELLE_ERROR_CODES.invalidArchive})},
        400,
      );
    }
    const snapshot = conversations.getSnapshot(imported.conversationId, await store.getState());
    if (!snapshot) {
      throw new Error('Imported conversation snapshot was not available.');
    }
    return json({conversation: snapshot.conversation, snapshot});
  });

  router.get('/api/conversations/:id', async ctx => {
    const id = ctx.params.id;
    const snapshot = await pi.getConversationSnapshot(id);
    if (!snapshot) {
      return conversationNotFound(id);
    }
    return json({snapshot});
  });

  router.get('/api/conversations/:id/diagnostics', async ctx => {
    const id = ctx.params.id;
    const diagnostics = await conversations.getConversationDiagnostics(id);
    if (!diagnostics) {
      return conversationNotFound(id);
    }
    return json({diagnostics});
  });

  router.post('/api/conversations/:id/repair', async ctx => {
    const id = ctx.params.id;
    try {
      return json({snapshot: await pi.repairConversation(id)});
    } catch (error) {
      if (isConversationNotFoundError(error)) {
        return conversationNotFound(id);
      }
      // The session file is still unreadable. Repair never invents one.
      return json({error: normalizeNelleError(error)}, 409);
    }
  });

  router.post('/api/conversations/:id/rebuild', async ctx => {
    const id = ctx.params.id;
    try {
      return json({snapshot: await pi.rebuildConversationFromProjection(id)});
    } catch (error) {
      if (isConversationNotFoundError(error)) {
        return conversationNotFound(id);
      }
      return json({error: normalizeNelleError(error)}, 500);
    }
  });

  router.patch('/api/conversations/:id', async ctx => {
    const id = ctx.params.id;
    const body = patchConversationSchema.parse(await ctx.body());
    const conversation = conversations.patchConversation(id, body);
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation, snapshot: conversations.getSnapshot(id, await store.getState())});
  });

  router.put('/api/conversations/:id/reasoning', async ctx => {
    const id = ctx.params.id;
    const body = conversationReasoningSchema.parse(await ctx.body());
    const conversation = conversations.setReasoningLevel(id, body.level);
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation, snapshot: conversations.getSnapshot(id, await store.getState())});
  });

  router.post('/api/conversations/:id/pin', async ctx => {
    const id = ctx.params.id;
    const conversation = conversations.patchConversation(id, {pinned: true});
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation});
  });

  router.post('/api/conversations/:id/unpin', async ctx => {
    const id = ctx.params.id;
    const conversation = conversations.patchConversation(id, {pinned: false});
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation});
  });

  router.delete('/api/conversations/:id', async ctx => {
    const id = ctx.params.id;
    const resources = conversations.getConversationDeleteResources(id);
    if (!resources) {
      return conversationNotFound(id);
    }
    if (!conversations.hardDeleteConversation(id)) {
      return conversationNotFound(id);
    }
    pi.resetSession(id);
    const cleanup = await deleteConversationResources(paths, resources);
    // Uploads the conversation owned, sent or not, go with it.
    await uploads.deleteForConversation(id);
    return json({ok: true, cleanup});
  });

  router.post('/api/conversations/:id/export', async ctx => {
    const id = ctx.params.id;
    const archive = await exportConversationArchive({
      paths,
      store,
      conversations,
      hostTools,
      conversationId: id,
    });
    if (!archive) {
      return conversationNotFound(id);
    }
    // `Uint8Array` is a valid body; the cast sidesteps the `ArrayBufferLike`
    // generic mismatch between the DOM and Node `BodyInit` type definitions.
    return new Response(archive.bytes as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${archive.filename.replace(/"/g, '')}"`,
      },
    });
  });

  router.delete('/api/conversations/:id/messages', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    pi.resetSession(id);
    conversations.clearConversationProjection(id);
    hostTools.deleteAuditEventsForConversation(id);
    return json({ok: true});
  });

  router.post('/api/conversations/:id/abort', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const result = await pi.abortConversation(id);
    return json({
      ok: true,
      ...result,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  router.post('/api/conversations/:id/runs/:runId/abort', async ctx => {
    const {id, runId} = ctx.params;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const result = await pi.abortConversationRun(id, runId);
    return json({
      ok: true,
      ...result,
      runId,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  router.post('/api/conversations/:id/compact', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = compactConversationSchema.parse(await ctx.body()) ?? {};
    const result = await pi.compactConversation(id, body.instructions);
    return json({
      ok: true,
      ...result,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  router.post('/api/conversations/:id/compact/stream', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = compactConversationSchema.parse(await ctx.body()) ?? {};
    return sseResponse(async sink => {
      try {
        if (process.env.NELLE_PI_DISABLED === '1') {
          throw new Error('Compaction requires the Pi harness.');
        }
        const stream = await pi.streamCompactConversation(id, body.instructions);
        await writeChatStream(sink, stream, id);
      } catch (error) {
        writeChatError(sink, error);
      }
    });
  });

  router.post('/api/conversations/:id/compact/abort', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const aborted = pi.abortCompaction(id);
    return json({
      ok: true,
      aborted,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  /**
   * Fork and clone both answer `ConversationCreatedResponse` -- a new conversation, and its
   * snapshot -- and both refuse the same way. A conversation with no messages has nothing to
   * branch from, and a fork must land on one of the user's own messages: those are the client
   * asking for something impossible, so they are a **409 with a code**, not the bare 500 they
   * used to be. The source conversation is never touched by either.
   */
  const branchConversation = async (
    id: string,
    branch: () => Promise<Awaited<ReturnType<PiHarness['forkConversation']>>>,
  ): Promise<Response> => {
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    try {
      const snapshot = await branch();
      return json({conversation: snapshot.conversation, snapshot});
    } catch (error) {
      const normalized = normalizeNelleError(error);
      // Both are the client asking for something that cannot exist, and both are a 409.
      //
      // `session_unavailable` was missed in M8 T1 and kept falling through to a bare 500: a
      // conversation whose Pi session file is gone has no history to branch, and the server said so
      // in a form no client could render. Found by the device suite, which is exactly the kind of
      // thing it is for -- a widget test stubs the response and would never have noticed.
      if (
        normalized.code === NELLE_ERROR_CODES.conversationNotBranchable ||
        normalized.code === NELLE_ERROR_CODES.sessionUnavailable
      ) {
        return json({error: normalized}, 409);
      }
      throw error;
    }
  };

  router.post('/api/conversations/:id/fork', async ctx => {
    const body = forkConversationRequestSchema.parse(await ctx.body());
    return branchConversation(ctx.params.id, () =>
      pi.forkConversation({
        conversationId: ctx.params.id,
        entryId: body.entryId,
        title: body.title,
      }),
    );
  });

  router.post('/api/conversations/:id/clone', async ctx => {
    const body = cloneConversationSchema.parse(await ctx.body()) ?? {};
    return branchConversation(ctx.params.id, () =>
      pi.cloneConversation({
        conversationId: ctx.params.id,
        entryId: body.entryId,
        title: body.title,
      }),
    );
  });
}

/** Shared with the chat routes, which run against a conversation and must refuse the same way. */
export function conversationNotFound(id: string): Response {
  return json(
    {error: {code: 'conversation_not_found', message: `Conversation ${id} was not found.`}},
    404,
  );
}
