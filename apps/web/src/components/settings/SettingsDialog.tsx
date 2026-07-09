import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Divider} from '@astryxdesign/core/Divider';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {
  HStack,
  Layout,
  LayoutContent,
  LayoutPanel,
  StackItem,
  VStack,
} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {Switch} from '@astryxdesign/core/Switch';
import {Text, Heading} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Token} from '@astryxdesign/core/Token';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  DocumentDuplicateIcon,
  LightBulbIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

import type {
  ConfiguredModel,
  ConversationListItem,
  HostToolSettings,
  LlamaRouterModel,
  LlamaRouterProps,
  RuntimeStatus,
} from '../../api';
import type {ParamRow, SettingsSection} from '../../types';
import {useSettingsStore} from '../../stores/settingsStore';
import {useUiStore} from '../../stores/uiStore';
import {formatBytes, formatRouterStatus, routerStatusColor} from '../../utils/format';

type SettingsDialogProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  runtime: RuntimeStatus | null;
  routerProps: LlamaRouterProps | null;
  routerModels: LlamaRouterModel[];
  runtimeTone: 'green' | 'yellow' | 'blue';
  onInstall: () => void | Promise<void>;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onToggleLogs: () => void | Promise<void>;
  onRefreshLogs: () => void | Promise<void>;
  onSaveRuntimeSettings: () => void | Promise<void>;
  models: ConfiguredModel[];
  activeModelId: string | null;
  activeRunModelIds: Set<string>;
  routerModelsByConfiguredId: Map<string, LlamaRouterModel>;
  busyAction: string | null;
  onActivateModel: (model: ConfiguredModel) => void | Promise<void>;
  onLoadModel: (model: ConfiguredModel) => void | Promise<void>;
  onUnloadModel: (model: ConfiguredModel) => void | Promise<void>;
  onReloadRouterModels: () => void | Promise<void>;
  onSaveModel: (model: ConfiguredModel) => void | Promise<void>;
  onDuplicateModel: (model: ConfiguredModel) => void | Promise<void>;
  onDeleteModel: (model: ConfiguredModel) => void | Promise<void>;
  onSaveGlobalParams: () => void | Promise<void>;
  onSaveReasoningBudgets: () => void | Promise<void>;
  hostTools: HostToolSettings | null;
  onAcknowledgeHostTools: () => void | Promise<void>;
  onHostToolsToggle: (enabled: boolean) => void | Promise<void>;
  onSearch: () => void | Promise<void>;
  onUseHuggingFaceModel: (repoId: string, quant: string) => void | Promise<void>;
  conversations: ConversationListItem[];
  onImportConversation: () => void;
  isImporting: boolean;
  onClearAllChats: () => void | Promise<void>;
};

/** Responsive, but a fixed size for any given viewport: sections never resize it. */
const SETTINGS_DIALOG_WIDTH = 'min(92vw, 1040px)';
const SETTINGS_DIALOG_HEIGHT = 'min(85vh, 760px)';

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  icon: typeof Cog6ToothIcon;
}> = [
  {id: 'runtime', icon: CpuChipIcon},
  {id: 'models', icon: SparklesIcon},
  {id: 'reasoning', icon: LightBulbIcon},
  {id: 'global', icon: Cog6ToothIcon},
  {id: 'tools', icon: ShieldCheckIcon},
  {id: 'chats', icon: ChatBubbleLeftRightIcon},
];

export function SettingsDialog({
  isOpen,
  onOpenChange,
  runtime,
  routerProps,
  routerModels,
  runtimeTone,
  onInstall,
  onStart,
  onStop,
  onRefresh,
  onToggleLogs,
  onRefreshLogs,
  onSaveRuntimeSettings,
  models,
  activeModelId,
  activeRunModelIds,
  routerModelsByConfiguredId,
  busyAction,
  onActivateModel,
  onLoadModel,
  onUnloadModel,
  onReloadRouterModels,
  onSaveModel,
  onDuplicateModel,
  onDeleteModel,
  onSaveGlobalParams,
  onSaveReasoningBudgets,
  hostTools,
  onAcknowledgeHostTools,
  onHostToolsToggle,
  onSearch,
  onUseHuggingFaceModel,
  conversations,
  onImportConversation,
  isImporting,
  onClearAllChats,
}: SettingsDialogProps) {
  const section = useUiStore(state => state.settingsSection);
  const onSectionChange = useUiStore(state => state.setSettingsSection);

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      width={SETTINGS_DIALOG_WIDTH}
      maxHeight={SETTINGS_DIALOG_HEIGHT}
      // Dialog is `height: fit-content`, so the modal would resize as the user
      // moves between sections. Pin it: inline styles outrank StyleX, which the
      // dialog's own class cannot. Each section scrolls inside LayoutContent.
      style={{height: SETTINGS_DIALOG_HEIGHT}}
      purpose="form"
      className="nelle-settings-dialog"
    >
      <Layout
        height="fill"
        header={<DialogHeader title="Settings" onOpenChange={onOpenChange} />}
        start={
          <LayoutPanel
            width="calc(var(--spacing-10) * 6)"
            padding={3}
            hasDivider
            label="Settings sections"
          >
            <List density="compact">
              {SETTINGS_SECTIONS.map(item => (
                <ListItem
                  key={item.id}
                  label={settingsSectionLabel(item.id)}
                  isSelected={section === item.id}
                  startContent={<Icon icon={item.icon} size="sm" />}
                  onClick={() => onSectionChange(item.id)}
                />
              ))}
            </List>
          </LayoutPanel>
        }
        content={
          <LayoutContent padding={4} className="nelle-settings-dialog-content">
            {section === 'runtime' && (
              <RuntimeSettingsSection
                runtime={runtime}
                routerProps={routerProps}
                routerModels={routerModels}
                runtimeTone={runtimeTone}
                busyAction={busyAction}
                onInstall={onInstall}
                onStart={onStart}
                onStop={onStop}
                onRefresh={onRefresh}
                onToggleLogs={onToggleLogs}
                onRefreshLogs={onRefreshLogs}
                onSaveRuntimeSettings={onSaveRuntimeSettings}
              />
            )}
            {section === 'models' && (
              <ModelSettingsSection
                models={models}
                activeModelId={activeModelId}
                activeRunModelIds={activeRunModelIds}
                runtime={runtime}
                routerModelsByConfiguredId={routerModelsByConfiguredId}
                busyAction={busyAction}
                onActivateModel={onActivateModel}
                onLoadModel={onLoadModel}
                onUnloadModel={onUnloadModel}
                onReloadRouterModels={onReloadRouterModels}
                onSaveModel={onSaveModel}
                onDuplicateModel={onDuplicateModel}
                onDeleteModel={onDeleteModel}
                onSearch={onSearch}
                onUseHuggingFaceModel={onUseHuggingFaceModel}
              />
            )}
            {section === 'reasoning' && (
              <ReasoningSettingsSection
                busyAction={busyAction}
                onSaveReasoningBudgets={onSaveReasoningBudgets}
              />
            )}
            {section === 'global' && (
              <GlobalSettingsSection
                busyAction={busyAction}
                onSaveGlobalParams={onSaveGlobalParams}
              />
            )}
            {section === 'tools' && (
              <HostToolsSettingsSection
                hostTools={hostTools}
                busyAction={busyAction}
                onAcknowledgeHostTools={onAcknowledgeHostTools}
                onHostToolsToggle={onHostToolsToggle}
              />
            )}
            {section === 'chats' && (
              <VStack gap={3}>
                <Heading level={3}>Chats</Heading>
                <Divider />
                <Text type="supporting" color="secondary">
                  {conversations.length.toLocaleString()} conversations stored locally.
                </Text>
                <HStack gap={2} wrap="wrap">
                  <Button
                    label="Import archive"
                    size="sm"
                    variant="secondary"
                    icon={<Icon icon={ArrowUpTrayIcon} size="sm" />}
                    isLoading={isImporting}
                    onClick={onImportConversation}
                  />
                  <Button
                    label="Clear all chats"
                    size="sm"
                    variant="secondary"
                    icon={<Icon icon={TrashIcon} size="sm" />}
                    isLoading={busyAction === 'clear-all-chats'}
                    onClick={onClearAllChats}
                  />
                </HStack>
              </VStack>
            )}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function RuntimeSettingsSection({
  runtime,
  routerProps,
  routerModels,
  runtimeTone,
  busyAction,
  onInstall,
  onStart,
  onStop,
  onRefresh,
  onToggleLogs,
  onRefreshLogs,
  onSaveRuntimeSettings,
}: {
  runtime: RuntimeStatus | null;
  routerProps: LlamaRouterProps | null;
  routerModels: LlamaRouterModel[];
  runtimeTone: 'green' | 'yellow' | 'blue';
  busyAction: string | null;
  onInstall: () => void | Promise<void>;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onToggleLogs: () => void | Promise<void>;
  onRefreshLogs: () => void | Promise<void>;
  onSaveRuntimeSettings: () => void | Promise<void>;
}) {
  const runtimeLogs = useSettingsStore(state => state.runtimeLogs);
  const isLogVisible = useSettingsStore(state => state.isLogVisible);
  const modelsMaxInput = useSettingsStore(state => state.modelsMaxInput);
  const sleepIdleInput = useSettingsStore(state => state.sleepIdleInput);
  const setModelsMaxInput = useSettingsStore(state => state.setModelsMaxInput);
  const setSleepIdleInput = useSettingsStore(state => state.setSleepIdleInput);
  const loadedRouterModelCount = routerModels.filter(
    model => model.status === 'loaded' || model.status === 'sleeping',
  ).length;
  const loadingRouterModelCount = routerModels.filter(model => model.status === 'loading').length;
  const routerCapacityLabel =
    runtime?.running && routerProps?.maxInstances != null
      ? `Router capacity: ${loadedRouterModelCount}/${routerProps.maxInstances} loaded${
          loadingRouterModelCount > 0 ? `, ${loadingRouterModelCount} loading` : ''
        }`
      : runtime?.running
        ? 'Router capacity unavailable'
        : 'Router stopped';

  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <Icon icon={CpuChipIcon} size="sm" color="secondary" />
        <Heading level={3}>llama.cpp</Heading>
      </HStack>
      <Divider />
      <VStack gap={3}>
        <HStack gap={2} wrap="wrap" vAlign="center">
          <Token
            label={
              runtime?.running
                ? `Running on ${runtime.host}:${runtime.port}`
                : runtime?.installed
                  ? 'Installed, stopped'
                  : 'Not installed'
            }
            color={runtimeTone}
          />
          <Token label={routerCapacityLabel} color={runtime?.running ? 'blue' : 'yellow'} />
        </HStack>
        <Text type="supporting" color="secondary" className="nelle-code">
          {runtime?.binaryPath ?? 'No llama-server binary detected'}
        </Text>
        <Text type="supporting" color="secondary" className="nelle-code">
          {runtime?.logPath ?? 'llama-server log path unavailable'}
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button
            label={runtime?.installed ? 'Update' : 'Install'}
            size="sm"
            variant="secondary"
            icon={<Icon icon={ArrowDownTrayIcon} size="sm" />}
            isLoading={busyAction === 'install'}
            onClick={onInstall}
          />
          <Button
            label="Start"
            size="sm"
            variant="primary"
            icon={<Icon icon={PlayIcon} size="sm" />}
            isDisabled={!runtime?.installed || runtime.running}
            isLoading={busyAction === 'start'}
            onClick={onStart}
          />
          <Button
            label="Stop"
            size="sm"
            variant="secondary"
            icon={<Icon icon={StopIcon} size="sm" />}
            isDisabled={!runtime?.running}
            isLoading={busyAction === 'stop'}
            onClick={onStop}
          />
          <Button
            label="Refresh"
            size="sm"
            variant="ghost"
            icon={<Icon icon={ArrowPathIcon} size="sm" />}
            onClick={onRefresh}
          />
          <Button
            label={isLogVisible ? 'Hide logs' : 'Show logs'}
            size="sm"
            variant="ghost"
            isLoading={busyAction === 'runtime-logs'}
            onClick={onToggleLogs}
          />
          {isLogVisible && (
            <Button
              label="Refresh logs"
              size="sm"
              variant="ghost"
              isLoading={busyAction === 'runtime-logs'}
              onClick={onRefreshLogs}
            />
          )}
        </HStack>
        {isLogVisible && (
          <CodeBlock
            code={runtimeLogs || 'No llama-server log output yet.'}
            language="text"
            width="100%"
            maxHeight="calc(var(--spacing-10) * 8)"
            isWrapped
          />
        )}
        <Divider />
        <VStack gap={2}>
          <TextInput
            label="Max loaded models"
            value={modelsMaxInput}
            onChange={setModelsMaxInput}
            description="Default is 1. Requires a llama.cpp restart."
          />
          <TextInput
            label="Sleep idle seconds"
            value={sleepIdleInput}
            onChange={setSleepIdleInput}
            description="Default is 90. Requires a llama.cpp restart."
          />
        </VStack>
        <HStack gap={2}>
          <Button
            label="Save runtime settings"
            size="sm"
            variant="primary"
            isLoading={busyAction === 'runtime-settings'}
            onClick={onSaveRuntimeSettings}
          />
        </HStack>
      </VStack>
    </VStack>
  );
}

function HostToolsSettingsSection({
  hostTools,
  busyAction,
  onAcknowledgeHostTools,
  onHostToolsToggle,
}: {
  hostTools: HostToolSettings | null;
  busyAction: string | null;
  onAcknowledgeHostTools: () => void | Promise<void>;
  onHostToolsToggle: (enabled: boolean) => void | Promise<void>;
}) {
  const acknowledged = hostTools?.acknowledged === true;
  const enabled = hostTools?.enabled === true;
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <Icon icon={ShieldCheckIcon} size="sm" color="secondary" />
        <Heading level={3}>Host Tools</Heading>
        <StackItem size="fill" />
        <Token label={enabled ? 'enabled' : 'disabled'} color={enabled ? 'yellow' : 'blue'} />
      </HStack>
      <Divider />
      <VStack gap={3}>
        {!acknowledged && (
          <Banner
            status="warning"
            title="Host file and shell tools run with the same OS permissions as the user who launched Nelle."
          />
        )}
        <Switch
          label="Enable host file and shell tools"
          description="Allows Pi to read files, edit files, search the project, and run shell commands from Nelle conversations."
          value={enabled}
          isDisabled={!acknowledged}
          disabledMessage="Acknowledge the host tool warning first."
          isLoading={busyAction === 'host-tools'}
          changeAction={checked => onHostToolsToggle(checked)}
        />
        {!acknowledged && (
          <HStack gap={2}>
            <Button
              label="Acknowledge and enable"
              size="sm"
              variant="primary"
              icon={<Icon icon={ShieldCheckIcon} size="sm" />}
              isLoading={busyAction === 'host-tools'}
              onClick={onAcknowledgeHostTools}
            />
          </HStack>
        )}
        {acknowledged && (
          <Text type="supporting" color="secondary">
            Tool calls are shown in chat and stored in the local audit log for each conversation.
          </Text>
        )}
      </VStack>
    </VStack>
  );
}

function GlobalSettingsSection({
  busyAction,
  onSaveGlobalParams,
}: {
  busyAction: string | null;
  onSaveGlobalParams: () => void | Promise<void>;
}) {
  const globalParamRows = useSettingsStore(state => state.globalParamRows);
  const setGlobalParamRows = useSettingsStore(state => state.setGlobalParamRows);

  return (
    <VStack gap={3}>
      <Heading level={3}>Global llama.cpp Params</Heading>
      <Divider />
      <Text type="supporting" color="secondary">
        Written to the <code className="nelle-code">[*]</code> section of models.ini and applied to
        every model.
      </Text>
      <KeyValueEditor rows={globalParamRows} onChange={setGlobalParamRows} />
      <HStack gap={2}>
        <Button
          label="Save global params"
          size="sm"
          variant="primary"
          isLoading={busyAction === 'global-params'}
          onClick={onSaveGlobalParams}
        />
      </HStack>
    </VStack>
  );
}

/**
 * llama.cpp caps a thinking block from `thinking_budget_tokens`. `max` has no
 * cap by definition, so only the three budgeted tiers appear here.
 */
function ReasoningSettingsSection({
  busyAction,
  onSaveReasoningBudgets,
}: {
  busyAction: string | null;
  onSaveReasoningBudgets: () => void | Promise<void>;
}) {
  const budgetInputs = useSettingsStore(state => state.reasoningBudgetInputs);
  const setBudgetInput = useSettingsStore(state => state.setReasoningBudgetInput);

  return (
    <VStack gap={3}>
      <Heading level={3}>Reasoning Budgets</Heading>
      <Divider />
      <Text type="supporting" color="secondary">
        Tokens each level may spend inside its thinking block before llama.cpp closes it. Use{' '}
        <code className="nelle-code">0</code> for no cap. The <strong>max</strong> level is always
        uncapped, and <strong>off</strong> disables thinking entirely.
      </Text>
      <VStack gap={2}>
        <TextInput
          label="Low"
          value={budgetInputs.low}
          onChange={value => setBudgetInput('low', value)}
          description="Default is 512 tokens."
        />
        <TextInput
          label="Medium"
          value={budgetInputs.medium}
          onChange={value => setBudgetInput('medium', value)}
          description="Default is 2048 tokens."
        />
        <TextInput
          label="High"
          value={budgetInputs.high}
          onChange={value => setBudgetInput('high', value)}
          description="Default is 8192 tokens."
        />
      </VStack>
      <HStack gap={2}>
        <Button
          label="Save reasoning budgets"
          size="sm"
          variant="primary"
          isLoading={busyAction === 'reasoning-budgets'}
          onClick={onSaveReasoningBudgets}
        />
      </HStack>
    </VStack>
  );
}

function ModelSettingsSection({
  models,
  activeModelId,
  activeRunModelIds,
  runtime,
  routerModelsByConfiguredId,
  busyAction,
  onActivateModel,
  onLoadModel,
  onUnloadModel,
  onReloadRouterModels,
  onSaveModel,
  onDuplicateModel,
  onDeleteModel,
  onSearch,
  onUseHuggingFaceModel,
}: {
  models: ConfiguredModel[];
  activeModelId: string | null;
  activeRunModelIds: Set<string>;
  runtime: RuntimeStatus | null;
  routerModelsByConfiguredId: Map<string, LlamaRouterModel>;
  busyAction: string | null;
  onActivateModel: (model: ConfiguredModel) => void | Promise<void>;
  onLoadModel: (model: ConfiguredModel) => void | Promise<void>;
  onUnloadModel: (model: ConfiguredModel) => void | Promise<void>;
  onReloadRouterModels: () => void | Promise<void>;
  onSaveModel: (model: ConfiguredModel) => void | Promise<void>;
  onDuplicateModel: (model: ConfiguredModel) => void | Promise<void>;
  onDeleteModel: (model: ConfiguredModel) => void | Promise<void>;
  onSearch: () => void | Promise<void>;
  onUseHuggingFaceModel: (repoId: string, quant: string) => void | Promise<void>;
}) {
  const searchQuery = useSettingsStore(state => state.searchQuery);
  const searchResults = useSettingsStore(state => state.searchResults);
  const isSearching = useSettingsStore(state => state.isSearching);
  const setSearchQuery = useSettingsStore(state => state.setSearchQuery);

  return (
    <VStack gap={5}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Heading level={3}>Configured Models</Heading>
          </StackItem>
          <Button
            label="Reload"
            size="sm"
            variant="ghost"
            icon={<Icon icon={ArrowPathIcon} size="sm" />}
            isDisabled={!runtime?.running}
            isLoading={busyAction === 'router-reload'}
            onClick={onReloadRouterModels}
          />
        </HStack>
        <Divider />
        {models.length === 0 && (
          <Text type="supporting" color="secondary">
            Search Hugging Face and choose a GGUF quant to create the first model.
          </Text>
        )}
        {models.map((model, index) => (
          <VStack key={model.id} gap={3}>
            {index > 0 && <Divider />}
            <ModelSettingsRow
              model={model}
              activeModelId={activeModelId}
              isRunLocked={activeRunModelIds.has(model.id)}
              runtime={runtime}
              routerModel={routerModelsByConfiguredId.get(model.id)}
              busyAction={busyAction}
              onActivateModel={onActivateModel}
              onLoadModel={onLoadModel}
              onUnloadModel={onUnloadModel}
              onSaveModel={onSaveModel}
              onDuplicateModel={onDuplicateModel}
              onDeleteModel={onDeleteModel}
            />
          </VStack>
        ))}
      </VStack>

      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Icon icon={MagnifyingGlassIcon} size="sm" color="secondary" />
          <Heading level={3}>Hugging Face GGUF Search</Heading>
        </HStack>
        <Divider />
        <TextInput
          label="Search query"
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="qwen coder gguf"
          startIcon={MagnifyingGlassIcon}
        />
        <HStack gap={2}>
          <Button
            label="Search GGUF models"
            size="sm"
            variant="primary"
            icon={<Icon icon={MagnifyingGlassIcon} size="sm" />}
            isLoading={isSearching}
            onClick={onSearch}
          />
        </HStack>
        <VStack gap={3}>
          {searchResults.map((result, index) => (
            <VStack key={result.id} gap={2}>
              {index > 0 && <Divider />}
              <VStack gap={0}>
                <Text type="label" weight="semibold">
                  {result.id}
                </Text>
                <Text type="supporting" color="secondary">
                  {result.downloads?.toLocaleString() ?? '0'} downloads
                </Text>
              </VStack>
              {result.quants.map(quant => (
                <HStack key={quant.quant} gap={2} vAlign="center">
                  <StackItem size="fill" className="nelle-tight">
                    <VStack gap={0}>
                      <Text type="supporting" className="nelle-code">
                        {quant.quant}
                      </Text>
                      <Text type="supporting" color="secondary">
                        {formatBytes(quant.size)}
                        {quant.files.length > 1 ? ` across ${quant.files.length} files` : ''}
                      </Text>
                    </VStack>
                  </StackItem>
                  <Button
                    label="Use"
                    size="sm"
                    variant="secondary"
                    isLoading={busyAction === `use:${result.id}:${quant.quant}`}
                    onClick={() => onUseHuggingFaceModel(result.id, quant.quant)}
                  />
                </HStack>
              ))}
            </VStack>
          ))}
        </VStack>
      </VStack>
    </VStack>
  );
}

function ModelSettingsRow({
  model,
  activeModelId,
  isRunLocked,
  runtime,
  routerModel,
  busyAction,
  onActivateModel,
  onLoadModel,
  onUnloadModel,
  onSaveModel,
  onDuplicateModel,
  onDeleteModel,
}: {
  model: ConfiguredModel;
  activeModelId: string | null;
  isRunLocked: boolean;
  runtime: RuntimeStatus | null;
  routerModel?: LlamaRouterModel;
  busyAction: string | null;
  onActivateModel: (model: ConfiguredModel) => void | Promise<void>;
  onLoadModel: (model: ConfiguredModel) => void | Promise<void>;
  onUnloadModel: (model: ConfiguredModel) => void | Promise<void>;
  onSaveModel: (model: ConfiguredModel) => void | Promise<void>;
  onDuplicateModel: (model: ConfiguredModel) => void | Promise<void>;
  onDeleteModel: (model: ConfiguredModel) => void | Promise<void>;
}) {
  const aliasDraft = useSettingsStore(state => state.modelAliasDrafts[model.id] ?? model.name);
  const paramRows = useSettingsStore(state => state.modelParamRows[model.id] ?? []);
  const setModelAliasDraft = useSettingsStore(state => state.setModelAliasDraft);
  const setModelParamRows = useSettingsStore(state => state.setModelParamRows);
  const routerStatus = routerModel?.status ?? (runtime?.running ? 'unlisted' : 'stopped');
  const isLoaded = routerStatus === 'loaded' || routerStatus === 'sleeping';
  const isLoading = routerStatus === 'loading';

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill" className="nelle-tight">
          <Text type="label" weight="semibold">
            {model.name}
          </Text>
        </StackItem>
        <Token label={formatRouterStatus(routerStatus)} color={routerStatusColor(routerStatus)} />
        {isRunLocked && <Token label="active run" color="yellow" />}
      </HStack>
      <Text type="supporting" color="secondary" className="nelle-code">
        {model.hfRef ?? model.presetName}
      </Text>
      {routerModel && (
        <Text type="supporting" color="secondary" className="nelle-code">
          router id: {routerModel.routerModelId ?? routerModel.sectionId}
        </Text>
      )}
      <TextInput
        label="Alias"
        value={aliasDraft}
        onChange={value => setModelAliasDraft(model.id, value)}
      />
      <KeyValueEditor rows={paramRows} onChange={rows => setModelParamRows(model.id, rows)} />
      <HStack gap={1} wrap="wrap">
        <Button
          label={model.id === activeModelId ? 'Selected' : 'Select'}
          size="sm"
          variant={model.id === activeModelId ? 'primary' : 'secondary'}
          isLoading={busyAction === 'activate'}
          onClick={() => onActivateModel(model)}
        />
        <Button
          label="Load"
          size="sm"
          variant="secondary"
          isDisabled={!runtime?.running || isLoaded || isLoading}
          isLoading={busyAction === `load:${model.id}`}
          onClick={() => onLoadModel(model)}
        />
        <Button
          label="Unload"
          size="sm"
          variant="ghost"
          isDisabled={!runtime?.running || !isLoaded || isRunLocked}
          isLoading={busyAction === `unload:${model.id}`}
          onClick={() => onUnloadModel(model)}
        />
        <Button
          label="Save"
          size="sm"
          variant="secondary"
          isDisabled={isRunLocked}
          isLoading={busyAction === `model-save:${model.id}`}
          onClick={() => onSaveModel(model)}
        />
        <IconButton
          label="Duplicate model"
          tooltip="Duplicate model"
          size="sm"
          variant="ghost"
          icon={<Icon icon={DocumentDuplicateIcon} size="sm" />}
          isLoading={busyAction === `model-duplicate:${model.id}`}
          onClick={() => onDuplicateModel(model)}
        />
        <IconButton
          label="Remove model"
          tooltip="Remove model"
          size="sm"
          variant="ghost"
          icon={<Icon icon={TrashIcon} size="sm" />}
          isDisabled={isRunLocked}
          isLoading={busyAction === `model-delete:${model.id}`}
          onClick={() => onDeleteModel(model)}
        />
      </HStack>
    </VStack>
  );
}

function KeyValueEditor({
  rows,
  onChange,
}: {
  rows: ParamRow[];
  onChange: (rows: ParamRow[]) => void;
}) {
  const visibleRows = rows.length > 0 ? rows : [{id: createParamRowId(), key: '', value: ''}];
  return (
    <VStack gap={1}>
      {visibleRows.map(row => (
        <HStack key={row.id} gap={1} vAlign="center">
          <StackItem size="fill" className="nelle-tight">
            <TextInput
              label="Key"
              isLabelHidden
              size="sm"
              placeholder="ctx-size"
              value={row.key}
              onChange={value => onChange(updateParamRows(visibleRows, row.id, {key: value}))}
            />
          </StackItem>
          <StackItem size="fill" className="nelle-tight">
            <TextInput
              label="Value"
              isLabelHidden
              size="sm"
              placeholder="32768"
              value={row.value}
              onChange={value => onChange(updateParamRows(visibleRows, row.id, {value}))}
            />
          </StackItem>
          <IconButton
            label="Remove parameter"
            tooltip="Remove parameter"
            size="sm"
            variant="ghost"
            icon={<Icon icon={TrashIcon} size="sm" />}
            onClick={() => onChange(visibleRows.filter(item => item.id !== row.id))}
          />
        </HStack>
      ))}
      <HStack gap={2}>
        <Button
          label="Add parameter"
          size="sm"
          variant="ghost"
          icon={<Icon icon={PlusIcon} size="sm" />}
          onClick={() => onChange([...visibleRows, {id: createParamRowId(), key: '', value: ''}])}
        />
      </HStack>
    </VStack>
  );
}

function updateParamRows(
  rows: ParamRow[],
  id: string,
  patch: Partial<Pick<ParamRow, 'key' | 'value'>>,
): ParamRow[] {
  return rows.map(row => (row.id === id ? {...row, ...patch} : row));
}

function createParamRowId(): string {
  return `param-${Math.random().toString(36).slice(2)}`;
}

function settingsSectionLabel(section: SettingsSection): string {
  if (section === 'runtime') {
    return 'Runtime';
  }
  if (section === 'models') {
    return 'Models';
  }
  if (section === 'reasoning') {
    return 'Reasoning';
  }
  if (section === 'global') {
    return 'Global Params';
  }
  if (section === 'tools') {
    return 'Tools';
  }
  return 'Chats';
}
