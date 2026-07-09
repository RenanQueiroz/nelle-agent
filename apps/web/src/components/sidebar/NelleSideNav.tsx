import {type ChangeEvent, useEffect, useMemo, useRef, useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';

import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {HStack, StackItem, VStack} from '@astryxdesign/core/Layout';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';
import {NavIcon} from '@astryxdesign/core/NavIcon';
import {
  SideNav,
  SideNavCollapseButton,
  SideNavHeading,
  SideNavItem,
} from '@astryxdesign/core/SideNav';
import {Spinner} from '@astryxdesign/core/Spinner';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {VisuallyHidden} from '@astryxdesign/core/VisuallyHidden';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
  BookmarkIcon,
  BookmarkSlashIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  DocumentDuplicateIcon,
  MagnifyingGlassIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

import type {ConversationListItem} from '../../api';
import type {AppNotice} from '../../types';
import {useConversationsStore} from '../../stores/conversationsStore';
import {useUiStore} from '../../stores/uiStore';

const SECTION_ROW_HEIGHT = 32;
const CONVERSATION_ROW_HEIGHT = 36;
/** Rows kept mounted past the viewport, and the band that triggers the next page. */
const OVERSCAN_ROWS = 8;
const SEARCH_DEBOUNCE_MS = 200;

type ConversationSectionId = 'pinned' | 'recent' | 'results';

type ConversationListRow =
  | {
      key: string;
      type: 'section';
      id: ConversationSectionId;
      label: string;
      count: number;
    }
  | {
      key: string;
      type: 'conversation';
      conversation: ConversationListItem;
    };

type ConversationActions = {
  onSelect: (conversationId: string) => void | Promise<void>;
  onTogglePin: (conversation: ConversationListItem) => void | Promise<void>;
  onRename: (conversation: ConversationListItem) => void | Promise<void>;
  onReset: (conversationId: string) => void | Promise<void>;
  onExport: (conversation: ConversationListItem) => void | Promise<void>;
  onClone: (conversation: ConversationListItem) => void | Promise<void>;
  onDelete: (conversation: ConversationListItem) => void | Promise<void>;
};

export function NelleSideNav({
  isCollapsed,
  onCollapsedChange,
  notice,
  onDismissNotice,
  isSettingsOpen,
  onToggleSettings,
  onNewConversation,
  isNewConversationBusy,
  onImportConversation,
  isImportBusy,
  archiveInputRef,
  onArchivePickerChange,
  activeConversationId,
  ...actions
}: {
  isCollapsed: boolean;
  onCollapsedChange: (isCollapsed: boolean) => void;
  notice: AppNotice | null;
  onDismissNotice: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  onNewConversation: () => void | Promise<void>;
  isNewConversationBusy: boolean;
  onImportConversation: () => void;
  isImportBusy: boolean;
  archiveInputRef: {current: HTMLInputElement | null};
  onArchivePickerChange: (event: ChangeEvent<HTMLInputElement>) => void;
  activeConversationId: string;
} & ConversationActions) {
  return (
    <SideNav
      data-testid="nelle-side-nav"
      className="nelle-side-nav"
      resizable={{
        defaultWidth: 300,
        minWidth: 248,
        maxWidth: 420,
        autoSaveId: 'nelle.sideNav.width',
      }}
      collapsible={{
        isCollapsed,
        onCollapsedChange,
        hasButton: false,
      }}
      header={
        <>
          <VisuallyHidden as="h2">Nelle Agent</VisuallyHidden>
          <SideNavHeading
            heading="Nelle Agent"
            subheading="Local Pi + llama.cpp"
            icon={<NavIcon icon={<Icon icon={ChatBubbleLeftRightIcon} size="sm" />} />}
            headerEndContent={
              <IconButton
                label="Settings"
                tooltip="Settings"
                size="sm"
                variant={isSettingsOpen ? 'secondary' : 'ghost'}
                icon={<Icon icon={Cog6ToothIcon} size="sm" />}
                onClick={onToggleSettings}
              />
            }
          />
        </>
      }
      topContent={
        isCollapsed ? (
          // Collapsed rail: the primary actions stacked as icons, the way
          // llama.cpp's sidebar presents them.
          <VStack gap={1} hAlign="center" className="nelle-side-nav-rail">
            <IconButton
              label="New chat"
              tooltip="New chat"
              size="sm"
              variant="primary"
              icon={<Icon icon={PlusIcon} size="sm" />}
              isLoading={isNewConversationBusy}
              onClick={() => void onNewConversation()}
            />
            <IconButton
              label="Settings"
              tooltip="Settings"
              size="sm"
              variant={isSettingsOpen ? 'secondary' : 'ghost'}
              icon={<Icon icon={Cog6ToothIcon} size="sm" />}
              onClick={onToggleSettings}
            />
          </VStack>
        ) : (
          <VStack gap={2} className="nelle-side-nav-top">
            {notice && (
              <Banner
                status={notice.type}
                title={notice.text}
                isDismissable
                onDismiss={onDismissNotice}
              />
            )}
            <HStack gap={1} vAlign="center">
              <StackItem size="fill" className="nelle-tight">
                <Button
                  className="nelle-side-nav-new-chat"
                  label="New chat"
                  size="sm"
                  variant="primary"
                  icon={<Icon icon={PlusIcon} size="sm" />}
                  isLoading={isNewConversationBusy}
                  onClick={onNewConversation}
                />
              </StackItem>
              <IconButton
                label="Import chat"
                tooltip="Import chat archive"
                size="sm"
                variant="ghost"
                icon={<Icon icon={ArrowUpTrayIcon} size="sm" />}
                isLoading={isImportBusy}
                onClick={onImportConversation}
              />
              <input
                ref={archiveInputRef}
                aria-label="Import conversation archive"
                className="nelle-hidden-file-input"
                type="file"
                accept=".nelle-chat.zip,application/zip"
                onChange={onArchivePickerChange}
              />
            </HStack>
            <ConversationSearchInput />
          </VStack>
        )
      }
      // Astryx's own button, placed exactly as their SideNavCollapseButton
      // example does. It reads collapse state from context, keeps the
      // Collapse/Expand labels in sync, and SideNav stacks the footer row
      // vertically when collapsed. Wrapping it in an HStack forced a row into a
      // 48px rail and pushed the expand button off-screen.
      footerIcons={<SideNavCollapseButton />}
    >
      {isCollapsed ? (
        <VStack className="nelle-side-nav-collapsed-spacer" />
      ) : (
        <ConversationVirtualList activeConversationId={activeConversationId} {...actions} />
      )}
    </SideNav>
  );
}

/**
 * Search state lives in the UI store so typing only re-renders the sidebar
 * instead of the whole workbench.
 *
 * The query goes to the server, because the sidebar only ever holds a window
 * onto the conversation list. Filtering that window client-side would report
 * "no matching chats" for any conversation the user has not scrolled to.
 */
function ConversationSearchInput() {
  const conversationSearch = useUiStore(state => state.conversationSearch);
  const setConversationSearch = useUiStore(state => state.setConversationSearch);
  const loadFirstPage = useConversationsStore(state => state.loadFirstPage);
  const loadedSearch = useConversationsStore(state => state.loadedSearch);

  const query = conversationSearch.trim();
  const isLoaded = query === loadedSearch;
  useEffect(() => {
    // The workbench already loaded this query -- on mount, or because a
    // conversation action refreshed the page. Do not ask again.
    if (isLoaded) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadFirstPage(query).catch(() => {
        // The sidebar keeps its last good page; the workbench surfaces errors.
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, isLoaded, loadFirstPage]);

  return (
    <TextInput
      label="Search conversations"
      isLabelHidden
      size="sm"
      value={conversationSearch}
      onChange={setConversationSearch}
      placeholder="Search chats"
      startIcon={MagnifyingGlassIcon}
      hasClear
    />
  );
}

function ConversationVirtualList({
  activeConversationId,
  ...actions
}: {
  activeConversationId: string;
} & ConversationActions) {
  const query = useUiStore(state => state.conversationSearch);
  const setConversationSearch = useUiStore(state => state.setConversationSearch);
  const conversations = useConversationsStore(state => state.conversations);
  const total = useConversationsStore(state => state.total);
  const nextCursor = useConversationsStore(state => state.nextCursor);
  const isLoadingMore = useConversationsStore(state => state.isLoadingMore);
  const loadNextPage = useConversationsStore(state => state.loadNextPage);
  const rows = useMemo(
    () => buildConversationRows(conversations, query, total),
    [conversations, query, total],
  );
  const scrollRef = useRef<HTMLElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: index =>
      rows[index]?.type === 'section' ? SECTION_ROW_HEIGHT : CONVERSATION_ROW_HEIGHT,
    getItemKey: index => rows[index]?.key ?? index,
    overscan: OVERSCAN_ROWS,
  });

  // Fetch the next page as the last rendered row comes into the overscan band,
  // so the scrollbar never reaches an end that is not the real end. The store
  // ignores re-entrant calls while a page is in flight.
  const virtualItems = virtualizer.getVirtualItems();
  const lastRenderedIndex = virtualItems[virtualItems.length - 1]?.index ?? -1;
  // `rows.length > 0` is not redundant. An empty list renders no virtual items,
  // so `lastRenderedIndex` is -1 and the band check passes vacuously, paging
  // the whole history in behind a view showing nothing.
  const isNearEnd = rows.length > 0 && lastRenderedIndex >= rows.length - 1 - OVERSCAN_ROWS;
  useEffect(() => {
    if (isNearEnd && nextCursor && !isLoadingMore) {
      void loadNextPage().catch(() => {
        // Leave the loaded rows in place; scrolling again retries.
      });
    }
  }, [isNearEnd, nextCursor, isLoadingMore, loadNextPage]);

  if (rows.length === 0) {
    return (
      <VStack data-testid="conversation-list" className="nelle-conversation-list-empty">
        {query.trim() ? (
          <EmptyState
            isCompact
            icon={<Icon icon={MagnifyingGlassIcon} size="md" color="secondary" />}
            title="No matching chats"
            description="Try a different search term."
            actions={
              <Button
                label="Clear search"
                size="sm"
                variant="secondary"
                onClick={() => setConversationSearch('')}
              />
            }
          />
        ) : (
          // No action here on purpose: the New chat button sits directly above.
          <EmptyState
            isCompact
            icon={<Icon icon={ChatBubbleLeftRightIcon} size="md" color="secondary" />}
            title="No chats yet"
            description="Start one with New chat above."
          />
        )}
      </VStack>
    );
  }

  return (
    <VStack
      ref={scrollRef}
      data-testid="conversation-list"
      gap={0}
      className="nelle-conversation-list"
    >
      <VStack
        gap={0}
        className="nelle-conversation-virtual-space"
        style={{height: `${virtualizer.getTotalSize()}px`}}
      >
        {virtualizer.getVirtualItems().map(virtualRow => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }
          return (
            <VStack
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              gap={0}
              className="nelle-conversation-virtual-row"
              style={{transform: `translateY(${virtualRow.start}px)`}}
            >
              {row.type === 'section' ? (
                <ConversationSectionRow row={row} />
              ) : (
                <ConversationRow
                  conversation={row.conversation}
                  isActive={row.conversation.id === activeConversationId}
                  {...actions}
                />
              )}
            </VStack>
          );
        })}
      </VStack>
      {isLoadingMore && (
        <HStack
          gap={2}
          align="center"
          justify="center"
          data-testid="conversation-list-loading-more"
          className="nelle-conversation-loading-more"
        >
          <Spinner size="sm" shade="subtle" aria-label="Loading more conversations" />
        </HStack>
      )}
    </VStack>
  );
}

function ConversationSectionRow({row}: {row: Extract<ConversationListRow, {type: 'section'}>}) {
  return (
    <HStack
      gap={2}
      vAlign="center"
      className="nelle-conversation-section-row"
      data-testid={`conversation-section-${row.id}`}
    >
      <StackItem size="fill" className="nelle-tight">
        <Text type="supporting" color="secondary" weight="semibold">
          {row.label}
        </Text>
      </StackItem>
      <Badge variant="neutral" label={String(row.count)} />
    </HStack>
  );
}

function ConversationRow({
  conversation,
  isActive,
  onSelect,
  onTogglePin,
  onRename,
  onReset,
  onExport,
  onClone,
  onDelete,
}: {
  conversation: ConversationListItem;
  isActive: boolean;
} & ConversationActions) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isOngoing = isOngoingConversationStatus(conversation.status);

  return (
    <VStack
      gap={0}
      className="nelle-conversation-row"
      data-testid={`conversation-row-${conversation.id}`}
      data-menu-open={isMenuOpen ? 'true' : undefined}
    >
      <SideNavItem
        label={conversation.title}
        isSelected={isActive}
        onClick={() => void onSelect(conversation.id)}
        endContent={
          <HStack gap={1} vAlign="center" className="nelle-conversation-row-end">
            {conversation.status !== 'ready' && (
              <ConversationStatusIndicator status={conversation.status} />
            )}
            {/* Reserves room for the overlaid actions menu so long titles do not run under it. */}
            <span aria-hidden="true" className="nelle-conversation-row-actions-spacer" />
          </HStack>
        }
      />
      {/*
        The menu is a sibling of the row button rather than its endContent:
        Astryx renders endContent inside the nav item's <button>, and nesting a
        button would both break semantics and select the chat on every menu click.
      */}
      <div className="nelle-conversation-row-actions">
        <MoreMenu
          size="sm"
          label={`Actions for ${conversation.title}`}
          onOpenChange={setIsMenuOpen}
          items={[
            {
              label: conversation.pinned ? 'Unpin' : 'Pin',
              icon: (
                <Icon icon={conversation.pinned ? BookmarkSlashIcon : BookmarkIcon} size="sm" />
              ),
              onClick: () => void onTogglePin(conversation),
            },
            {
              label: 'Rename',
              icon: <Icon icon={PencilIcon} size="sm" />,
              onClick: () => void onRename(conversation),
            },
            {
              label: 'Duplicate',
              icon: <Icon icon={DocumentDuplicateIcon} size="sm" />,
              onClick: () => void onClone(conversation),
            },
            {type: 'divider'},
            {
              label: 'Export',
              icon: <Icon icon={ArrowDownTrayIcon} size="sm" />,
              onClick: () => void onExport(conversation),
            },
            {
              label: 'Reset',
              icon: <Icon icon={ArrowPathIcon} size="sm" />,
              isDisabled: isOngoing,
              onClick: () => void onReset(conversation.id),
            },
            {type: 'divider'},
            {
              label: 'Delete',
              icon: <Icon icon={TrashIcon} size="sm" />,
              isDisabled: isOngoing,
              onClick: () => void onDelete(conversation),
            },
          ]}
        />
      </div>
    </VStack>
  );
}

function ConversationStatusIndicator({status}: {status: ConversationListItem['status']}) {
  const label = status.replace(/_/g, ' ');
  const variant = status === 'unavailable' ? 'error' : status === 'running' ? 'accent' : 'warning';
  return (
    <HStack gap={1} vAlign="center" className="nelle-conversation-status">
      {isOngoingConversationStatus(status) ? (
        <Spinner size="sm" shade="subtle" aria-label={`Conversation ${label} in progress`} />
      ) : (
        <StatusDot
          label={`Conversation ${label}`}
          tooltip={`Conversation ${label}`}
          variant={variant}
        />
      )}
      <Text type="supporting" color="secondary">
        {label}
      </Text>
    </HStack>
  );
}

function isOngoingConversationStatus(status: ConversationListItem['status']): boolean {
  return status === 'running' || status === 'compacting' || status === 'aborting';
}

/**
 * Flattens the loaded page into pinned and recent sections.
 *
 * `query` only picks the section label. The server did the filtering; the rows
 * handed in are already the matches. `total` counts every match, including the
 * ones not paged in yet, so the section header does not report the size of the
 * scroll window as the size of the list.
 */
function buildConversationRows(
  conversations: ConversationListItem[],
  query: string,
  total: number,
): ConversationListRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const pinned = conversations.filter(conversation => conversation.pinned);
  const unpinned = conversations.filter(conversation => !conversation.pinned);
  // Every pinned row arrives on the first page, so the remainder is unpinned.
  const unpinnedTotal = Math.max(total - pinned.length, unpinned.length);
  const rows: ConversationListRow[] = [];
  if (pinned.length > 0) {
    rows.push({
      key: 'section:pinned',
      type: 'section',
      id: 'pinned',
      label: 'Pinned',
      count: pinned.length,
    });
    for (const conversation of pinned) {
      rows.push({key: `conversation:${conversation.id}`, type: 'conversation', conversation});
    }
  }
  if (unpinned.length > 0) {
    rows.push({
      key: normalizedQuery ? 'section:results' : 'section:recent',
      type: 'section',
      id: normalizedQuery ? 'results' : 'recent',
      label: normalizedQuery ? 'Results' : 'Recent',
      count: unpinnedTotal,
    });
    for (const conversation of unpinned) {
      rows.push({key: `conversation:${conversation.id}`, type: 'conversation', conversation});
    }
  }
  return rows;
}
