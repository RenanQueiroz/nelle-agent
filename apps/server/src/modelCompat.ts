import type {ConfiguredModel} from './types';
export function llamaRuntimeModelId(model: ConfiguredModel): string {
  return model.presetName || model.id;
}

/**
 * Title generation is a one-shot summarisation call, so it never wants a
 * thinking block. A chat template that does not declare `enable_thinking`
 * ignores the kwarg, which is why this needs no per-model gate: Qwen and Gemma
 * both read it, Llama-style templates simply do not.
 */
export function chatTemplateKwargsForModel(_model: ConfiguredModel): Record<string, unknown> {
  return {
    chat_template_kwargs: {
      enable_thinking: false,
      preserve_thinking: true,
    },
  };
}
