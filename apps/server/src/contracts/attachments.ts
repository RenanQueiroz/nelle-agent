/**
 * The one place attachment limits are defined.
 *
 * They used to live twice -- the browser's composer allowed 20 files while
 * `chatRequestSchema` capped the array at 10, so an eleventh file passed the
 * composer and came back as an HTTP 500 carrying a serialized zod array. One
 * definition, imported by both the schema and whatever enforces it.
 *
 * It carries no zod. That was once a *requirement* (the web bundle imported it and
 * carried no zod); the bundle is gone, so it is now simply true and costs nothing.
 * Nothing forces it to stay that way, and nothing requires changing it either.
 */
export const ATTACHMENT_LIMITS = {
  /** Attachment items per message. Rendered PDF pages count as items. */
  maxFiles: 20,
  maxFileBytes: 25 * 1024 * 1024,
  maxDraftBytes: 100 * 1024 * 1024,
  maxTextCharacters: 200_000,
  maxRenderedPdfPages: 20,
  /**
   * Base64 expands by 4/3, so a 25 MiB image is ~35 MB of characters. The extra
   * headroom covers the data-URL prefix a client may or may not strip.
   */
  maxImageDataCharacters: 40_000_000,
} as const;

export const ATTACHMENT_LIMIT_MESSAGES = {
  tooManyFiles: `Attach at most ${ATTACHMENT_LIMITS.maxFiles} files per message.`,
  draftTooLarge: 'Attachments are limited to 100 MiB per message.',
} as const;
