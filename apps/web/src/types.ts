import type {
  ChatAttachmentInput,
  ChatStreamEvent,
  ConfiguredModel,
  LlamaModelProps,
  LlamaRouterModel,
} from './api';

export type DraftAttachment = ChatAttachmentInput & {
  warning?: string;
};

export type ComposerModelOptionDetail = {
  model: ConfiguredModel;
  routerStatus: string;
  routerModel?: LlamaRouterModel;
  props?: LlamaModelProps | null;
  isFavorite: boolean;
  progressPercent: number | null;
};

export type SettingsSection = 'runtime' | 'models' | 'global' | 'tools' | 'chats';

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
