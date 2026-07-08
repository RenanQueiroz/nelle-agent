import type {ConfiguredModel} from './types';
import {canonicalizeHuggingFaceRef} from '../../../packages/shared/src/modelsIni.ts';

export function llamaRuntimeModelId(model: ConfiguredModel): string {
  return model.hfRef ? canonicalizeHuggingFaceRef(model.hfRef) : model.presetName;
}

export function isQwenFamilyModel(model: ConfiguredModel): boolean {
  return [model.name, model.presetName, model.repoId, model.hfRef]
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
