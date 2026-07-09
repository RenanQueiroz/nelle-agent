import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {z} from 'zod';

import type {AppPaths} from './paths';
import type {AppStore} from './store';
import type {HostToolRepository, ToolAuditEvent} from './hostTools';
import type {
  ConversationRepository,
  ImportedAttachmentInput,
  SyncConversationEntry,
} from './conversations';

const ARCHIVE_FORMAT = 'nelle-chat';
const ARCHIVE_VERSION = 1;

const manifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.literal(ARCHIVE_VERSION),
  exportedAt: z.string(),
  appVersion: z.string(),
  conversation: z
    .object({
      id: z.string(),
      title: z.string(),
    })
    .optional(),
  source: z
    .object({
      platform: z.string(),
    })
    .optional(),
  /** Exported from a conversation whose Pi session file was already lost. */
  piSessionMissing: z.boolean().optional(),
  files: z.record(z.string(), z.string()),
});

const archiveAttachmentSchema = z.object({
  id: z.string().optional(),
  piEntryId: z.string().optional(),
  uploadId: z.string().optional(),
  kind: z.enum(['text', 'pdf', 'image']),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  storagePath: z.string().optional(),
  textPreview: z.string().optional(),
  textContent: z.string().optional(),
  processing: z.unknown().optional(),
  createdAt: z.string().optional(),
});

const archiveEntrySchema = z.object({
  piEntryId: z.string(),
  parentPiEntryId: z.string().optional(),
  entryType: z.string(),
  role: z.enum(['user', 'assistant', 'system']).optional(),
  textPreview: z.string().optional(),
  createdAt: z.string(),
  modelId: z.string().optional(),
  modelRuntimeId: z.string().optional(),
  modelAliasSnapshot: z.string().optional(),
  performance: z.unknown().optional(),
  toolCalls: z.unknown().optional(),
  attachmentSummary: z.unknown().optional(),
  regeneratesPiEntryId: z.string().optional(),
  displayGroupId: z.string().optional(),
});

const sidecarSchema = z.object({
  conversation: z.object({
    title: z.string().optional(),
    titleSource: z.string().optional(),
    defaultModelId: z.string().optional(),
    activeLeafPiEntryId: z.string().optional(),
  }),
  entries: z.array(archiveEntrySchema),
  activePathEntryIds: z.array(z.string()).optional(),
  attachments: z.array(archiveAttachmentSchema),
  context: z.unknown().optional(),
  models: z.unknown().optional(),
});

export type ConversationArchiveExport = {
  filename: string;
  bytes: Uint8Array;
};

export async function exportConversationArchive(input: {
  paths: AppPaths;
  store: AppStore;
  conversations: ConversationRepository;
  hostTools?: HostToolRepository;
  conversationId: string;
}): Promise<ConversationArchiveExport | null> {
  const state = await input.store.getState();
  const snapshot = input.conversations.getSnapshot(input.conversationId, state);
  if (!snapshot) {
    return null;
  }
  const binding = input.conversations.getPiSessionBinding(input.conversationId);
  // An `unavailable` conversation must still export. Its SQLite sidecar is the
  // only surviving copy of the messages, and refusing to export it would leave
  // the user with nothing to salvage.
  const piSessionText = await readPiSessionText(binding?.piSessionPath);
  const piSessionMissing = piSessionText == null;
  const attachments = input.conversations.getStoredAttachmentsForConversation(input.conversationId);
  const sidecar = {
    ...snapshot,
    attachments,
  };
  const files: Record<string, Uint8Array> = {
    'pi-session.jsonl': strToU8(piSessionText ?? ''),
    'nelle-conversation.json': jsonBytes(sidecar),
    'models-manifest.json': jsonBytes(snapshot.models),
    'tool-audit.jsonl': strToU8(renderToolAuditJsonl(input.hostTools, input.conversationId)),
  };

  for (const attachment of attachments) {
    if (!attachment.storagePath) {
      continue;
    }
    const archivePath = archiveStoragePath(attachment.storagePath);
    if (!archivePath || files[archivePath]) {
      continue;
    }
    const absolutePath = resolveDataPath(input.paths.dataDir, attachment.storagePath);
    files[archivePath] = new Uint8Array(await fs.readFile(absolutePath));
  }

  const checksums = Object.fromEntries(
    Object.entries(files).map(([filePath, bytes]) => [filePath, sha256(bytes)]),
  );
  files['manifest.json'] = jsonBytes({
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: '1.0.0',
    conversation: {
      id: snapshot.conversation.id,
      title: snapshot.conversation.title,
    },
    source: {
      platform: process.platform,
    },
    // An importer cannot tell an empty session file from a lost one, and
    // restoring a lost one would silently produce a conversation with no
    // history at all.
    piSessionMissing,
    files: checksums,
  });

  return {
    filename: `${slugifyArchiveName(snapshot.conversation.title)}.nelle-chat.zip`,
    bytes: zipSync(files),
  };
}

/** `null` when the bound Pi session file is gone, rather than an empty string. */
async function readPiSessionText(sessionPath: string | undefined): Promise<string | null> {
  if (!sessionPath) {
    return null;
  }
  try {
    return await fs.readFile(sessionPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function renderToolAuditJsonl(
  hostTools: HostToolRepository | undefined,
  conversationId: string,
): string {
  const rows = hostTools?.listAuditEvents(conversationId) ?? [];
  return rows.map(toolAuditJsonLine).join('');
}

function toolAuditJsonLine(event: ToolAuditEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export async function importConversationArchive(input: {
  paths: AppPaths;
  store: AppStore;
  conversations: ConversationRepository;
  bytes: Uint8Array;
}): Promise<{conversationId: string}> {
  assertNoDuplicateZipEntries(input.bytes);
  const archive = unzipSync(input.bytes);
  validateArchivePaths(Object.keys(archive));
  const manifest = manifestSchema.parse(readJsonArchiveEntry(archive, 'manifest.json'));
  verifyManifestChecksums(archive, manifest.files);
  if (manifest.piSessionMissing) {
    // The archive is a salvage bundle, not a conversation. Importing it would
    // produce an empty chat whose sidecar promises messages it cannot show.
    const error = new Error(
      'This archive was exported from a conversation whose Pi session file was missing, so it carries no message history to import.',
    );
    Object.assign(error, {code: 'archive_session_missing', retryable: false});
    throw error;
  }
  const sidecar = sidecarSchema.parse(readJsonArchiveEntry(archive, 'nelle-conversation.json'));
  const piSessionText = readTextArchiveEntry(archive, 'pi-session.jsonl');
  const importedSessionId = `import-${crypto.randomUUID()}`;
  const importedSessionPath = path.join(
    input.paths.piSessionsDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}_${importedSessionId}.jsonl`,
  );
  await fs.mkdir(input.paths.piSessionsDir, {recursive: true});
  await fs.writeFile(
    importedSessionPath,
    rewritePiSessionHeader(piSessionText, importedSessionId, input.paths.repoRoot),
    {flag: 'wx'},
  );

  const imported = input.conversations.createConversation({
    title: `${sidecar.conversation.title?.trim() || 'Imported chat'} (import)`,
    titleSource: 'imported',
    defaultModelId: sidecar.conversation.defaultModelId ?? null,
  });
  input.conversations.attachPiSession(imported.id, {
    piSessionPath: importedSessionPath,
    piSessionId: importedSessionId,
    activeLeafPiEntryId:
      sidecar.conversation.activeLeafPiEntryId ?? sidecar.entries.at(-1)?.piEntryId,
  });
  input.conversations.replaceConversationProjection(imported.id, {
    piSessionPath: importedSessionPath,
    piSessionId: importedSessionId,
    activeLeafPiEntryId:
      sidecar.conversation.activeLeafPiEntryId ?? sidecar.entries.at(-1)?.piEntryId,
    lastSyncedPiEntryId:
      sidecar.conversation.activeLeafPiEntryId ?? sidecar.entries.at(-1)?.piEntryId,
    status: 'ready',
    entries: sidecar.entries.map(entry => mapImportedEntry(entry)),
  });

  await writeImportedAttachmentFiles(input.paths.dataDir, archive, sidecar.attachments);
  input.conversations.createImportedAttachments(
    imported.id,
    sidecar.attachments.map(attachment => mapImportedAttachment(attachment)),
  );

  if (!input.conversations.getSnapshot(imported.id, await input.store.getState())) {
    throw new Error('Imported conversation snapshot was not available.');
  }
  return {conversationId: imported.id};
}

function mapImportedEntry(entry: z.infer<typeof archiveEntrySchema>): SyncConversationEntry {
  return {
    piEntryId: entry.piEntryId,
    parentPiEntryId: entry.parentPiEntryId,
    entryType: entry.entryType,
    role: entry.role,
    text: entry.textPreview ?? '',
    createdAt: entry.createdAt,
    modelId: entry.modelId,
    modelRuntimeId: entry.modelRuntimeId,
    modelAliasSnapshot: entry.modelAliasSnapshot,
    performance: entry.performance,
    toolCalls: entry.toolCalls,
    attachmentSummary: entry.attachmentSummary,
    regeneratesPiEntryId: entry.regeneratesPiEntryId,
    displayGroupId: entry.displayGroupId,
  };
}

function mapImportedAttachment(
  attachment: z.infer<typeof archiveAttachmentSchema>,
): ImportedAttachmentInput {
  return {
    piEntryId: attachment.piEntryId,
    uploadId: attachment.uploadId,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    storagePath: attachment.storagePath,
    textContent: attachment.textContent,
    processing: attachment.processing,
    createdAt: attachment.createdAt,
  };
}

async function writeImportedAttachmentFiles(
  dataDir: string,
  archive: Record<string, Uint8Array>,
  attachments: Array<z.infer<typeof archiveAttachmentSchema>>,
): Promise<void> {
  for (const attachment of attachments) {
    if (!attachment.storagePath) {
      continue;
    }
    const archivePath = archiveStoragePath(attachment.storagePath);
    if (!archivePath) {
      throw new Error(`Invalid attachment storage path: ${attachment.storagePath}`);
    }
    const bytes = archive[archivePath];
    if (!bytes) {
      throw new Error(`Attachment file missing from archive: ${archivePath}`);
    }
    const absolutePath = resolveDataPath(dataDir, attachment.storagePath);
    await fs.mkdir(path.dirname(absolutePath), {recursive: true});
    await fs.writeFile(absolutePath, bytes);
  }
}

function readJsonArchiveEntry(archive: Record<string, Uint8Array>, filePath: string): unknown {
  return JSON.parse(readTextArchiveEntry(archive, filePath));
}

function readTextArchiveEntry(archive: Record<string, Uint8Array>, filePath: string): string {
  const entry = archive[filePath];
  if (!entry) {
    throw new Error(`Archive is missing ${filePath}.`);
  }
  return strFromU8(entry);
}

function verifyManifestChecksums(
  archive: Record<string, Uint8Array>,
  checksums: Record<string, string>,
): void {
  for (const [filePath, expected] of Object.entries(checksums)) {
    const bytes = archive[filePath];
    if (!bytes) {
      throw new Error(`Archive is missing checksummed file ${filePath}.`);
    }
    if (sha256(bytes) !== expected) {
      throw new Error(`Checksum mismatch for ${filePath}.`);
    }
  }
}

function assertNoDuplicateZipEntries(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('Zip64 conversation archives are not supported.');
  }
  if (centralDirectoryOffset + centralDirectorySize > bytes.byteLength) {
    throw new Error('Archive central directory is invalid.');
  }

  const decoder = new TextDecoder();
  const seen = new Set<string>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Archive central directory is invalid.');
    }
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const filenameStart = offset + 46;
    const filenameEnd = filenameStart + filenameLength;
    const recordEnd = filenameEnd + extraLength + commentLength;
    if (recordEnd > bytes.byteLength) {
      throw new Error('Archive central directory is invalid.');
    }
    const filename = decoder.decode(bytes.subarray(filenameStart, filenameEnd));
    if (seen.has(filename)) {
      throw new Error(`Archive contains duplicate file entry: ${filename}`);
    }
    seen.add(filename);
    offset = recordEnd;
  }
  if (offset !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error('Archive central directory is invalid.');
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumSize = 22;
  const maximumCommentSize = 0xffff;
  const start = Math.max(0, view.byteLength - minimumSize - maximumCommentSize);
  for (let offset = view.byteLength - minimumSize; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + minimumSize + commentLength === view.byteLength) {
      return offset;
    }
  }
  throw new Error('Archive is not a valid zip file.');
}

function validateArchivePaths(filePaths: string[]): void {
  for (const filePath of filePaths) {
    if (
      filePath.startsWith('/') ||
      filePath.includes('\\') ||
      filePath.split('/').some(segment => segment === '..' || segment === '')
    ) {
      throw new Error(`Archive contains an unsafe path: ${filePath}`);
    }
  }
}

function archiveStoragePath(storagePath: string): string | null {
  if (!isSafeRelativePath(storagePath) || !storagePath.startsWith('attachments/')) {
    return null;
  }
  return storagePath;
}

function resolveDataPath(dataDir: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`Invalid relative data path: ${relativePath}`);
  }
  const resolved = path.resolve(dataDir, ...relativePath.split('/'));
  const root = path.resolve(dataDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Data path escapes Nelle data directory: ${relativePath}`);
  }
  return resolved;
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some(segment => segment === '..' || segment === '')
  );
}

function rewritePiSessionHeader(text: string, sessionId: string, cwd: string): string {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) {
    return `${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`;
  }
  const first = JSON.parse(lines[0]!);
  if (!first || typeof first !== 'object' || first.type !== 'session') {
    throw new Error('Imported Pi session is missing a session header.');
  }
  lines[0] = JSON.stringify({
    ...first,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
    parentSession: undefined,
  });
  return `${lines.join('\n')}\n`;
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function slugifyArchiveName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'nelle-chat';
}
