import path from 'node:path';

import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import {json, type Router} from '../http/router';
import {isPathWithin, resolveRelativeDataPath} from '../lib/files';
import type {RouteDeps} from './deps';

export function registerAttachmentRoutes(router: Router, deps: RouteDeps): void {
  const {paths, conversations, log} = deps;

  /**
   * The bytes of an attachment a message already carries.
   *
   * This exists because of the phone. A past message's bytes are not on the client and
   * never were: the composer previews an image because it just read those bytes off
   * disk, but a transcript loaded from a snapshot has only metadata. Until now the only
   * honest thing a client could render for a past attachment was a chip.
   *
   * `storage_path` comes out of the database, so it is not trusted as a path: it is
   * resolved against the data directory and refused if it escapes, and refused again if
   * it is not under the attachments tree. A row is not a capability to read any file on
   * the machine.
   */
  router.get('/api/attachments/:id/content', async ctx => {
    const attachment = conversations.getAttachmentById(ctx.params.id);
    if (!attachment?.storagePath) {
      // No row, or a row whose bytes were never stored (a text attachment lives in the
      // database, not on disk).
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'Attachment not found.'}},
        404,
      );
    }

    const resolved = resolveRelativeDataPath(paths.dataDir, attachment.storagePath);
    if (!resolved || !isPathWithin(resolved, path.resolve(paths.attachmentsDir))) {
      log.warn(
        {attachmentId: attachment.id},
        'attachment storage path escapes the attachments tree',
      );
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'Attachment not found.'}},
        404,
      );
    }

    const file = Bun.file(resolved);
    if (!(await file.exists())) {
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'The attachment file is missing.'}},
        404,
      );
    }

    return new Response(file, {
      headers: {
        'content-type': attachment.mimeType ?? 'application/octet-stream',
        // Content-addressed: the bytes at this id can never change, so a client may
        // keep them forever. That is what makes a phone's transcript cheap to reopen.
        'cache-control': 'private, max-age=31536000, immutable',
        // The name is the user's, and a browser will happily execute what it is handed.
        'content-disposition': `inline; filename="${encodeURIComponent(attachment.name)}"`,
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
