import {useState} from 'react';

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {Icon} from '@astryxdesign/core/Icon';
import {HStack} from '@astryxdesign/core/Layout';
import {Markdown} from '@astryxdesign/core/Markdown';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Text} from '@astryxdesign/core/Text';
import {LightBulbIcon} from '@heroicons/react/24/outline';

import {usePreferencesStore} from '../../stores/preferencesStore';

/**
 * llama.cpp streams thinking on `delta.reasoning_content`, separate from the
 * answer, so this renders it as its own panel above the bubble rather than
 * carving tags out of the message text. It opens while the model is thinking
 * and folds away once the answer starts, unless the reader says otherwise.
 */
export function ThinkingBlock({reasoning, isStreaming}: {reasoning: string; isStreaming: boolean}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const showThinkingInProgress = usePreferencesStore(state => state.showThinkingInProgress);
  const renderThinkingAsMarkdown = usePreferencesStore(state => state.renderThinkingAsMarkdown);
  // The reader's own click always wins over the preference.
  const isOpen = openOverride ?? (isStreaming && showThinkingInProgress);

  return (
    <Collapsible
      className="nelle-thinking-block"
      isOpen={isOpen}
      onOpenChange={setOpenOverride}
      trigger={
        <HStack gap={2} align="center">
          {isStreaming ? (
            <Spinner size="sm" aria-label="Thinking" />
          ) : (
            <Icon icon={LightBulbIcon} size="sm" />
          )}
          <Text type="supporting">{isStreaming ? 'Thinking…' : 'Reasoning'}</Text>
        </HStack>
      }
    >
      {renderThinkingAsMarkdown ? (
        <Markdown density="compact">{reasoning}</Markdown>
      ) : (
        <Text type="code">{reasoning}</Text>
      )}
    </Collapsible>
  );
}
