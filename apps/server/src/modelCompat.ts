import type {ConfiguredModel} from './types';

export function isQwenFamilyModel(model: ConfiguredModel): boolean {
  return [model.name, model.presetName, model.repoId, model.hfRef, model.filename]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes('qwen');
}

export function chatTemplateKwargsForModel(model: ConfiguredModel): Record<string, unknown> {
  if (!isQwenFamilyModel(model)) {
    return {};
  }
  return {
    chat_template_kwargs: {
      enable_thinking: false,
      preserve_thinking: true,
    },
  };
}
