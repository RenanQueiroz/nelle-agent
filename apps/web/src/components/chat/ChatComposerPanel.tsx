import {type ChangeEvent, useMemo, useRef} from 'react';

import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {
  Selector,
  SelectorOption,
  type SelectorOptionData,
  type SelectorOptionType,
} from '@astryxdesign/core/Selector';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {createStaticSource, TypeaheadItem, type SearchableItem} from '@astryxdesign/core/Typeahead';
import {DocumentTextIcon, PaperClipIcon, PhotoIcon, StarIcon} from '@heroicons/react/24/outline';

import type {ConfiguredModel, ConversationContextUsage, LlamaModelProps} from '../../api';
import {useComposerStore} from '../../stores/composerStore';
import type {ComposerModelOptionDetail, DraftAttachment} from '../../types';
import {
  ATTACHMENT_LIMITS,
  attachmentTooltip,
  getDraftAttachmentError,
  prepareDraftAttachments,
} from '../../utils/attachments';
import {
  contextProgressVariant,
  formatInteger,
  getContextOverflowMessage,
  getContextWarningMessage,
  positiveTokenCount,
} from '../../utils/context';
import {formatRouterStatus, routerStatusColor} from '../../utils/format';

type SlashCommandData = {
  description: string;
};

const SUPPORTED_SLASH_COMMANDS: SearchableItem<SlashCommandData>[] = [
  {
    id: 'compact',
    label: 'compact',
    auxiliaryData: {
      description: 'Compact this conversation context',
    },
  },
];

const slashCommandSource = createStaticSource(SUPPORTED_SLASH_COMMANDS);

const slashCommandTrigger: ChatComposerTrigger = {
  character: '/',
  searchSource: slashCommandSource,
  renderItem: item => (
    <TypeaheadItem
      item={item}
      description={(item.auxiliaryData as SlashCommandData | undefined)?.description}
    />
  ),
  onSelect: item => ({
    value: `/${item.label}`,
    label: `/${item.label}`,
    variant: 'yellow' as const,
  }),
  emptySearchResultsText: 'Only /compact is supported in Nelle chat.',
  menuLabel: 'Nelle slash commands',
};

export function ChatComposerPanel({
  activeModel,
  activeModelProps,
  activeModelId,
  activeModelIsFavorite,
  activeComposerRouterStatus,
  isRuntimeRunning,
  contextUsage,
  isStreaming,
  isCompacting,
  composerModelSelectorOptions,
  composerModelDetailsById,
  onSubmit,
  onStop,
  onSelectModel,
  onToggleFavorite,
}: {
  activeModel: ConfiguredModel | null;
  activeModelProps: LlamaModelProps | null;
  activeModelId: string | null;
  activeModelIsFavorite: boolean;
  activeComposerRouterStatus: string | null;
  isRuntimeRunning: boolean;
  contextUsage: ConversationContextUsage;
  isStreaming: boolean;
  isCompacting: boolean;
  composerModelSelectorOptions: SelectorOptionType[];
  composerModelDetailsById: Map<string, ComposerModelOptionDetail>;
  onSubmit: (value: string) => void | Promise<void>;
  onStop: () => void;
  onSelectModel: (modelId: string) => void | Promise<void>;
  onToggleFavorite: () => void;
}) {
  const draft = useComposerStore(state => state.draft);
  const attachments = useComposerStore(state => state.attachments);
  const isPdfImageModeEnabled = useComposerStore(state => state.isPdfImageModeEnabled);
  const slashCommandError = useComposerStore(state => state.slashCommandError);
  const error = useComposerStore(state => state.error);
  const warning = useComposerStore(state => state.warning);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeModelSupportsVision = activeModelProps?.modalities.vision === true;

  const blockingMessage = useMemo(() => {
    if (slashCommandError) {
      return slashCommandError;
    }
    if (error) {
      return error;
    }
    const attachmentError = getDraftAttachmentError(attachments, activeModelProps);
    if (attachmentError) {
      return attachmentError;
    }
    if (!isRuntimeRunning) {
      return 'Start llama.cpp before chatting.';
    }
    if (!activeModel) {
      return 'Select a GGUF model before chatting.';
    }
    return getContextOverflowMessage(contextUsage);
  }, [
    activeModel,
    activeModelProps,
    attachments,
    contextUsage,
    error,
    isRuntimeRunning,
    slashCommandError,
  ]);
  const warningMessage =
    blockingMessage == null ? (warning ?? getContextWarningMessage(contextUsage)) : null;
  const status = blockingMessage
    ? ({type: 'error', message: blockingMessage} as const)
    : warningMessage
      ? ({type: 'warning', message: warningMessage} as const)
      : undefined;

  async function handleFiles(files: File[]) {
    const store = useComposerStore.getState();
    store.setError(null);
    store.setWarning(null);
    try {
      const result = await prepareDraftAttachments(files, {
        existing: store.attachments,
        canAttachImages: activeModelSupportsVision,
        renderPdfImages: store.isPdfImageModeEnabled && activeModelSupportsVision,
      });
      if (result.attachments.length > 0) {
        useComposerStore.getState().addAttachments(result.attachments);
      }
      if (result.warning) {
        useComposerStore.getState().setWarning(result.warning);
      }
    } catch (fileError) {
      useComposerStore
        .getState()
        .setError(fileError instanceof Error ? fileError.message : String(fileError));
    }
  }

  function handleFilePickerChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length > 0) {
      void handleFiles(files);
    }
  }

  function handleDraftChange(value: string) {
    const store = useComposerStore.getState();
    store.setDraft(value);
    // Deliberately test the *rendered* status, not the live store: after a
    // rejected send, ChatComposer clears its value (calling this) in the same
    // tick the rejection set the status, and that reset must not dismiss it.
    // A later keystroke re-renders first, so real edits still clear the status.
    if (slashCommandError) {
      store.setSlashCommandError(null);
    }
    if (error) {
      store.setError(null);
    }
  }

  return (
    <ChatComposer
      className="nelle-chat-composer"
      onSubmit={onSubmit}
      value={draft}
      onChange={handleDraftChange}
      placeholder={
        activeModel
          ? 'Ask Nelle to inspect files, run shell commands, or reason about the project'
          : 'Select a GGUF model before chatting'
      }
      // Astryx sets pointer-events: none on the whole composer when isDisabled
      // is set, which would also kill the stop button. Stay enabled during a
      // run and reject sends instead.
      isDisabled={!activeModel || !isRuntimeRunning}
      isStopShown={isStreaming || isCompacting}
      onStop={onStop}
      headerActions={
        <HStack gap={1} vAlign="center">
          <IconButton
            label="Attach files"
            tooltip="Attach files"
            size="sm"
            variant="ghost"
            icon={<Icon icon={PaperClipIcon} size="sm" />}
            isDisabled={isStreaming || isCompacting}
            onClick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            aria-label="Attach files"
            className="nelle-hidden-file-input"
            type="file"
            multiple
            accept="text/*,.txt,.md,.json,.csv,.log,.pdf,application/pdf,image/png,image/jpeg,image/webp,image/gif"
            onChange={handleFilePickerChange}
          />
        </HStack>
      }
      headerContext={<ContextWindowUsage context={contextUsage} />}
      drawer={
        attachments.length > 0 || activeModelSupportsVision ? (
          <AttachmentDrawer
            attachments={attachments}
            canRenderPdfImages={activeModelSupportsVision}
            pdfImageModeEnabled={isPdfImageModeEnabled}
          />
        ) : undefined
      }
      input={
        <ChatComposerInput
          triggers={[slashCommandTrigger]}
          onFiles={files => void handleFiles(files)}
        />
      }
      status={status}
      statusPosition={blockingMessage ? 'top' : 'bottom'}
      footerActions={
        <HStack gap={1} vAlign="center" wrap="wrap">
          <Selector
            label="Model"
            isLabelHidden
            size="sm"
            className="nelle-composer-model-selector"
            hasSearch
            searchPlaceholder="Search models"
            placeholder="Select model"
            options={composerModelSelectorOptions}
            value={activeModelId ?? undefined}
            changeAction={onSelectModel}
            renderOption={option => (
              <ComposerModelSelectorOption
                option={option}
                detail={composerModelDetailsById.get(option.value)}
              />
            )}
          />
          {activeModel && (
            <IconButton
              label={activeModelIsFavorite ? 'Unfavorite model' : 'Favorite model'}
              tooltip={activeModelIsFavorite ? 'Unfavorite model' : 'Favorite model'}
              size="sm"
              variant={activeModelIsFavorite ? 'primary' : 'ghost'}
              icon={<Icon icon={StarIcon} size="sm" />}
              onClick={onToggleFavorite}
            />
          )}
          {activeComposerRouterStatus && (
            <Tooltip content="Selected model router status">
              <Token
                size="sm"
                color={routerStatusColor(activeComposerRouterStatus)}
                label={formatRouterStatus(activeComposerRouterStatus)}
              />
            </Tooltip>
          )}
          <Tooltip content="Supported command: compact this conversation context">
            <Token size="sm" color="yellow" label="/compact" />
          </Tooltip>
        </HStack>
      }
    />
  );
}

function ContextWindowUsage({context}: {context: ConversationContextUsage}) {
  const totalTokens = positiveTokenCount(context.totalTokens);
  if (totalTokens == null) {
    return null;
  }
  const usedTokens = positiveTokenCount(context.usedTokens) ?? 0;
  const progressTokens = Math.min(usedTokens, totalTokens);
  const tooltip = `Context: ${formatInteger(usedTokens)} / ${formatInteger(totalTokens)} tokens`;

  return (
    <Tooltip content={tooltip}>
      <HStack
        vAlign="center"
        className="nelle-context-progress"
        data-testid="composer-context-progress"
      >
        <ProgressBar
          label="Context window usage"
          value={progressTokens}
          max={totalTokens}
          isLabelHidden
          variant={contextProgressVariant(context)}
        />
      </HStack>
    </Tooltip>
  );
}

function AttachmentDrawer({
  attachments,
  canRenderPdfImages,
  pdfImageModeEnabled,
}: {
  attachments: DraftAttachment[];
  canRenderPdfImages: boolean;
  pdfImageModeEnabled: boolean;
}) {
  const removeAttachment = useComposerStore(state => state.removeAttachment);
  const setPdfImageModeEnabled = useComposerStore(state => state.setPdfImageModeEnabled);
  return (
    <ChatComposerDrawer
      count={attachments.length}
      label="Attachments"
      data-testid="attachment-drawer"
    >
      <VStack gap={2}>
        {canRenderPdfImages && (
          <Switch
            label="Render PDFs as images"
            description={`Converts up to ${ATTACHMENT_LIMITS.maxRenderedPdfPages.toLocaleString()} PDF pages into image attachments for vision models.`}
            value={pdfImageModeEnabled}
            changeAction={setPdfImageModeEnabled}
          />
        )}
        {attachments.length > 0 && (
          <HStack gap={1} vAlign="center" wrap="wrap">
            {attachments.map(attachment => (
              <Tooltip key={attachment.id} content={attachmentTooltip(attachment)}>
                <Token
                  size="sm"
                  color={
                    attachment.kind === 'image'
                      ? 'blue'
                      : attachment.kind === 'pdf'
                        ? 'red'
                        : 'gray'
                  }
                  label={attachment.name}
                  icon={
                    <Icon
                      icon={attachment.kind === 'image' ? PhotoIcon : DocumentTextIcon}
                      size="sm"
                    />
                  }
                  onRemove={() => removeAttachment(attachment.id)}
                />
              </Tooltip>
            ))}
          </HStack>
        )}
      </VStack>
    </ChatComposerDrawer>
  );
}

function ComposerModelSelectorOption({
  option,
  detail,
}: {
  option: SelectorOptionData;
  detail?: ComposerModelOptionDetail;
}) {
  if (!detail) {
    return <SelectorOption label={option.label ?? option.value} />;
  }

  return (
    <SelectorOption
      label={option.label ?? option.value}
      description={
        <VStack gap={1}>
          <Text type="supporting" color="secondary">
            {formatComposerModelDescription(detail)}
          </Text>
          {detail.routerStatus === 'loading' && (
            <ProgressBar
              label={`${detail.model.name} load progress`}
              isLabelHidden
              value={detail.progressPercent ?? 0}
              isIndeterminate={detail.progressPercent == null}
              variant="accent"
            />
          )}
        </VStack>
      }
      endContent={
        <HStack gap={1} vAlign="center" wrap="wrap">
          {detail.isFavorite && <Token size="sm" color="blue" label="favorite" />}
          <Token
            size="sm"
            color={routerStatusColor(detail.routerStatus)}
            label={formatRouterStatus(detail.routerStatus)}
          />
          {detail.routerStatus === 'loading' && detail.progressPercent != null && (
            <Token size="sm" color="blue" label={`${Math.round(detail.progressPercent)}%`} />
          )}
        </HStack>
      }
    />
  );
}

function formatComposerModelDescription(detail: ComposerModelOptionDetail): string {
  const parts = [detail.model.hfRef ?? detail.model.presetName];
  const contextWindow =
    positiveTokenCount(detail.props?.contextWindow) ??
    positiveTokenCount(detail.model.params.contextSize);
  if (contextWindow != null) {
    parts.push(`ctx ${formatInteger(contextWindow)}`);
  }
  if (detail.props) {
    parts.push(detail.props.modalities.vision ? 'images supported' : 'text only');
  }
  return parts.join(' | ');
}
