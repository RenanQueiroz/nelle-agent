import type {ConversationRepository} from './conversations';
import type {AppStore} from './store';
import type {ConfiguredModel} from './types';

/**
 * The model a run on this conversation uses.
 *
 * The conversation's own model wins; the globally active model is the fallback --
 * and it is what a conversation is stamped with when it is created, so an untouched
 * conversation still runs on whatever is active. Without this, picking a model for a
 * quick question silently swapped the model out from under a long-running project
 * chat, which is why assistant messages have to record the model that produced them.
 *
 * One resolver, used by chat, regenerate and compact alike, so a run cannot load one
 * model and answer with another.
 */
export async function resolveConversationModel(
  conversations: ConversationRepository,
  store: AppStore,
  conversationId: string,
): Promise<ConfiguredModel | null> {
  const pinned = conversations.getConversation(conversationId)?.default_model_id;
  if (pinned) {
    const model = await store.getModel(pinned);
    if (model) {
      return model;
    }
    // The pinned model is gone from models.ini (the user removed it). Fall back to
    // the active model rather than refusing to answer a conversation that worked
    // yesterday.
  }
  return store.getActiveModel();
}
