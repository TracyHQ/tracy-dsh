import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { UserTextFold } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/**
 * Runtime registry of fenced-block folds for sent user text, one per fence
 * name. It lives on the root Conversation service rather than in
 * ui-primitives because every client bundle carries its own copy of that
 * package: the transcript (ui-chat), the queue strip (this package), and the
 * plugin registering a fold each hold a different module instance, and only a
 * service is shared between them. Consumers read {@link source} and pass the
 * list to `projectUserText`.
 */
export class UserTextFoldRegistry extends ConversationDefinitionRegistry<UserTextFold> {
  /** Observable face of the registered folds, in registration order. */
  readonly source: ObservableSnapshot<readonly UserTextFold[]> = {
    getSnapshot: () => this.entries(),
    subscribe: listener => this.subscribe(listener),
  }

  /**
   * Register one fold for the caller's lifetime.
   * @param fold - the fence name it claims and its reader.
   * @returns idempotent disposer.
   * @throws if another fold already claims the fence.
   */
  register(fold: UserTextFold): () => void {
    return this.registerDefinition(
      fold.fence,
      fold,
      `user text fold for fence "${fold.fence}" is already registered`,
      `uiConversation.userTextFolds.register(${JSON.stringify(fold.fence)})`,
    )
  }
}
