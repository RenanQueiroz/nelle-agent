import {
  getModelsIniSectionValues,
  listModelsIniSections,
  parseModelsIni,
  removeModelsIniKeys,
  removeModelsIniSection,
  upsertModelsIniValues,
  writeModelsIniAtomic,
} from '../contracts/modelsIni';
import type {AppPaths} from '../lib/paths';
import {llamaRuntimeModelId} from '../models/compat';
import type {ConfiguredModel} from '../lib/types';
import {AppStore, modelSourceValues} from '../models/store';

/**
 * `models.ini` — reading it and writing it back without losing anything.
 *
 * **All three of the other llama clusters depend on this**, which is why it is its own module rather
 * than a corner of the router client: `startInternal` writes the preset before it launches; the
 * router client reads the configured sections to work out which of llama.cpp's advertised models are
 * actually Nelle's; and the load orchestrator writes `offline = 1` to pin a model to its weights.
 * Left inside any one of them, it drags the ini parser into the other two.
 *
 * Nothing here touches the manager's private state — it needs `paths` and `store` and nothing else,
 * which is what makes it a free function rather than a method.
 */

/** The preset on disk, or `''` when there is not one yet. A missing file is not an error. */
async function readPreset(paths: AppPaths): Promise<string> {
  return Bun.file(paths.llamaPresetPath)
    .text()
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    });
}

/**
 * Rewrites `models.ini` from the catalog, **preserving everything Nelle does not own**.
 *
 * The parser is lossless on purpose: comments, ordering, and any key the user put there by hand all
 * survive. Nelle writes `hf-repo`, `alias`, and the user's own free-form params — and **no
 * llama.cpp defaults**, because restating a default to its owner buys nothing and leaves a mystery
 * row in every model's parameter editor.
 */
export async function writePreset(
  paths: AppPaths,
  store: AppStore,
  _activeModel?: ConfiguredModel,
): Promise<void> {
  const state = await store.getState();
  let document = parseModelsIni(await readPreset(paths));
  document = upsertModelsIniValues(document, null, {version: 1});
  document = upsertModelsIniValues(document, '*', state.globalModelParams);

  for (const model of state.models) {
    document = upsertModelsIniValues(
      document,
      llamaRuntimeModelId(model),
      modelSourceValues(model),
    );
    document = removeModelsIniKeys(document, llamaRuntimeModelId(model), ['load-on-startup']);
  }

  await writeModelsIniAtomic(paths.llamaPresetPath, document);
}

/** Drops a model's section. Its blobs stay on disk; deleting weights is a separate, explicit act. */
export async function removeModelSection(paths: AppPaths, modelId: string): Promise<void> {
  const document = removeModelsIniSection(parseModelsIni(await readPreset(paths)), modelId);
  await writeModelsIniAtomic(paths.llamaPresetPath, document);
}

/**
 * Every model Nelle has configured, from the catalog **and** from the file.
 *
 * Both, because `models.ini` is hand-editable: a section the user added by hand is as real as one
 * Nelle wrote. This is what lets `mergeRouterModels` tell Nelle's models apart from the strangers
 * llama.cpp advertises out of its download cache — which it does unconditionally, with no flag to
 * turn it off.
 */
export async function readConfiguredModelSections(
  paths: AppPaths,
  store: AppStore,
): Promise<Array<{sectionId: string; alias?: string; hfRepo?: string}>> {
  const state = await store.getState();
  const sections = new Map<string, {sectionId: string; alias?: string; hfRepo?: string}>();
  for (const model of state.models) {
    sections.set(llamaRuntimeModelId(model), {
      sectionId: llamaRuntimeModelId(model),
      alias: model.name,
      hfRepo: model.hfRef,
    });
  }

  const document = parseModelsIni(await readPreset(paths));
  for (const sectionId of listModelsIniSections(document)) {
    if (sectionId === '*') {
      continue;
    }
    const values = getModelsIniSectionValues(document, sectionId);
    sections.set(sectionId, {
      sectionId,
      alias: values.get('alias') ?? sections.get(sectionId)?.alias,
      hfRepo: values.get('hf-repo') ?? sections.get(sectionId)?.hfRepo,
    });
  }

  return Array.from(sections.values());
}
