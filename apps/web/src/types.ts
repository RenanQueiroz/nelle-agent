import type {ChatStreamEvent, ConfiguredModel, LlamaModelProps, LlamaRouterModel} from './api';

/**
 * A file the user picked, already uploaded. The bytes live on the server; the
 * draft holds only what the composer needs to draw a chip.
 */
export type DraftAttachment = {
  uploadId: string;
  kind: 'text' | 'pdf' | 'image';
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  /** PDFs only, so the drawer can say how many pages it would render. */
  pageCount?: number;
};

export type ComposerModelOptionDetail = {
  model: ConfiguredModel;
  routerStatus: string;
  routerModel?: LlamaRouterModel;
  props?: LlamaModelProps | null;
  isFavorite: boolean;
  progressPercent: number | null;
};

export type SettingsSection = 'runtime' | 'models' | 'reasoning' | 'global' | 'tools' | 'chats';

export type ActiveRunKind = Extract<ChatStreamEvent, {type: 'run.started'}>['kind'];

export type AppNotice = {
  type: 'info' | 'warning' | 'error' | 'success';
  text: string;
};

export type ParamRow = {
  id: string;
  key: string;
  value: string;
};

export type CommandStatusRow = {
  id: string;
  conversationId: string;
  kind: 'compact';
  runId?: string;
  status: 'pending' | 'compacting' | 'completed' | 'failed' | 'aborted';
  instructions: string;
  message: string;
  createdAt: string;
  completedAt?: string;
};
