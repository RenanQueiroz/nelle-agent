import type {ConfiguredModel} from './types';

export function llamaRuntimeModelId(model: ConfiguredModel): string {
  return model.hfRef ? canonicalizeHuggingFaceRef(model.hfRef) : model.presetName;
}

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

function canonicalizeHuggingFaceRef(ref: string): string {
  const tagSeparator = ref.lastIndexOf(':');
  if (tagSeparator < 0) {
    return ref;
  }

  const base = ref.slice(0, tagSeparator + 1);
  const tag = ref.slice(tagSeparator + 1);
  const suffix = tag.match(/[-.]([a-z0-9_]+)$/i)?.[1];
  return `${base}${(suffix ?? tag).toUpperCase()}`;
}
