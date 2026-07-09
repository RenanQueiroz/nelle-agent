import {useEffect, useState} from 'react';

import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Icon} from '@astryxdesign/core/Icon';
import {Text} from '@astryxdesign/core/Text';
import {ExclamationTriangleIcon} from '@heroicons/react/24/outline';

import type {ConversationDiagnostics} from '../../api';
import {getConversationDiagnostics} from '../../api';

/**
 * Shown instead of the transcript when a conversation's Pi session file cannot
 * be read.
 *
 * Repair only succeeds if the file came back, so it is offered first. Rebuild
 * always succeeds and always loses something, so it names what it loses before
 * the user commits.
 */
export function UnavailableConversationPanel({
  conversationId,
  isBusy,
  onRepair,
  onRebuild,
  onDelete,
}: {
  conversationId: string;
  isBusy: boolean;
  onRepair: () => void | Promise<void>;
  onRebuild: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const diagnostics = useConversationDiagnostics(conversationId);
  const savedMessages = diagnostics?.projectionEntryCount ?? 0;

  return (
    <VStack
      gap={3}
      hAlign="center"
      data-testid="conversation-unavailable"
      className="nelle-unavailable-panel"
    >
      <EmptyState
        icon={<Icon icon={ExclamationTriangleIcon} size="md" color="error" />}
        title="This conversation cannot be opened"
        description={
          diagnostics?.reason ??
          'Nelle could not read the Pi session file that stores this conversation.'
        }
        actions={
          <HStack gap={2} wrap="wrap" hAlign="center">
            <Button
              label="Repair"
              size="sm"
              variant="primary"
              isDisabled={isBusy}
              onClick={() => void onRepair()}
            />
            <Button
              label="Rebuild from saved messages"
              size="sm"
              variant="secondary"
              isDisabled={isBusy || savedMessages === 0}
              onClick={() => void onRebuild()}
            />
            <Button
              label="Delete"
              size="sm"
              variant="ghost"
              isDisabled={isBusy}
              onClick={() => void onDelete()}
            />
          </HStack>
        }
      />
      {diagnostics?.piSessionPath && (
        <Text type="supporting" color="secondary" className="nelle-code">
          {diagnostics.piSessionPath}
        </Text>
      )}
      <Text type="supporting" color="secondary">
        {savedMessages > 0
          ? `Restore that file and choose Repair to recover everything. Nelle still holds ${savedMessages.toLocaleString()} ${savedMessages === 1 ? 'message' : 'messages'} for this conversation, so Rebuild can reconstruct the chat without it.`
          : 'Restore that file and choose Repair. Nelle holds no saved messages for this conversation, so there is nothing to rebuild from.'}
      </Text>
    </VStack>
  );
}

function useConversationDiagnostics(conversationId: string): ConversationDiagnostics | null {
  const [diagnostics, setDiagnostics] = useState<ConversationDiagnostics | null>(null);
  useEffect(() => {
    if (!conversationId) {
      return;
    }
    let isCancelled = false;
    void (async () => {
      try {
        const next = await getConversationDiagnostics(conversationId);
        if (!isCancelled) {
          setDiagnostics(next);
        }
      } catch {
        if (!isCancelled) {
          setDiagnostics(null);
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, [conversationId]);
  return diagnostics;
}
