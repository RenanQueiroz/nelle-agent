import path from 'node:path';

import type {
  ConfiguredModel,
  HuggingFaceFile,
  HuggingFaceModelResult,
  HuggingFaceQuant,
} from './types';
import {AppStore} from './store';

/**
 * Hugging Face already parsed the GGUF, and Nelle used to throw it away.
 *
 * `gguf.total` is the parameter count, `context_length` the window the model was
 * trained for, and `architecture` its family. `totalFileSize` is **not** a repo
 * total and **not** a per-quant size -- it is the size of the one file Hugging
 * Face chose to parse -- so it is deliberately not read.
 */
type HfGguf = {
  total?: number;
  architecture?: string;
  context_length?: number;
};

type HfModelListItem = {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  gguf?: HfGguf;
  siblings?: Array<{rfilename: string; size?: number}>;
};

type HfModelInfo = HfModelListItem;

export class HuggingFaceService {
  constructor(private readonly store: AppStore) {}

  /**
   * One list request carries the GGUF metadata and the file names for every hit;
   * the per-repo request that follows exists only for file *sizes*, which the
   * list endpoint does not return however it is asked.
   *
   * Before this, the detail requests were made anyway and returned less: no
   * architecture, no parameter count, no trained context window, and -- because
   * `?blobs=true` was never passed -- `size: null` for every file.
   */
  async searchGgufModels(query: string): Promise<HuggingFaceModelResult[]> {
    const search = query.trim() || 'gguf';
    const url = new URL('https://huggingface.co/api/models');
    url.searchParams.set('search', search);
    url.searchParams.set('filter', 'gguf');
    url.searchParams.set('sort', 'downloads');
    url.searchParams.set('direction', '-1');
    url.searchParams.set('limit', '12');
    for (const field of ['gguf', 'siblings', 'downloads', 'likes', 'tags', 'author']) {
      url.searchParams.append('expand[]', field);
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Hugging Face search failed: ${response.status}`);
    }

    const list = (await response.json()) as HfModelListItem[];
    const detailed = await Promise.all(
      list.slice(0, 8).map(item => this.getModelInfo(item.id, item)),
    );

    return detailed.filter(result => result.quants.length > 0);
  }

  async useHuggingFaceGguf(input: {
    repoId: string;
    quant: string;
    name?: string;
  }): Promise<ConfiguredModel> {
    validateHuggingFaceRef(input.repoId, input.quant);
    return this.store.addHuggingFaceModel({
      name: input.name ?? `${input.repoId}:${input.quant}`,
      repoId: input.repoId,
      quant: input.quant,
    });
  }

  /** `?blobs=true` is what makes `size` a number instead of `null`. */
  private async getModelInfo(
    repoId: string,
    fallback: HfModelListItem,
  ): Promise<HuggingFaceModelResult> {
    const response = await fetch(`https://huggingface.co/api/models/${repoId}?blobs=true`);
    // A repo that answers nothing, or one with no `gguf` block, degrades to what
    // the list already said rather than throwing the whole search away.
    const info = response.ok ? ((await response.json()) as HfModelInfo) : fallback;
    const files = extractGgufFiles(info);
    const gguf = fallback.gguf ?? info.gguf;
    return {
      id: info.id ?? repoId,
      author: info.author ?? fallback.author,
      downloads: info.downloads ?? fallback.downloads,
      likes: info.likes ?? fallback.likes,
      tags: info.tags ?? fallback.tags ?? [],
      architecture: gguf?.architecture,
      parameterCount: positiveInteger(gguf?.total),
      contextTrain: positiveInteger(gguf?.context_length),
      files,
      quants: extractGgufQuants(files),
    };
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function extractGgufFiles(info: HfModelInfo): HuggingFaceFile[] {
  return (info.siblings ?? [])
    .filter(file => isModelGguf(file.rfilename))
    .map(file => ({
      filename: file.rfilename,
      size: file.size ?? null,
    }))
    .sort((a, b) => {
      const bySize = (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER);
      return bySize === 0 ? a.filename.localeCompare(b.filename) : bySize;
    });
}

function extractGgufQuants(files: HuggingFaceFile[]): HuggingFaceQuant[] {
  const quants = new Map<string, HuggingFaceFile[]>();
  for (const file of files) {
    const quant = extractQuant(file.filename);
    if (!quant) {
      continue;
    }
    const existing = quants.get(quant) ?? [];
    existing.push(file);
    quants.set(quant, existing);
  }

  return [...quants.entries()]
    .map(([quant, quantFiles]) => ({
      quant,
      files: quantFiles,
      size: sumKnownSizes(quantFiles),
    }))
    .sort((a, b) => {
      const bySize = (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER);
      return bySize === 0 ? a.quant.localeCompare(b.quant) : bySize;
    });
}

function extractQuant(filename: string): string | null {
  const stem = path.posix
    .basename(filename)
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '');
  const parts = stem.split('-');
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = parts.slice(index).join('-');
    if (isQuant(candidate)) {
      return candidate.toUpperCase();
    }
  }
  return null;
}

function isQuant(value: string): boolean {
  return /^(?:UD-)?(?:IQ[1-4](?:_[A-Z0-9]+)+|Q[2-8](?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|MXFP4(?:_MOE)?|TQ[12](?:_[A-Z0-9]+)+)$/i.test(
    value,
  );
}

function isModelGguf(filename: string): boolean {
  const base = path.posix.basename(filename).toLowerCase();
  return base.endsWith('.gguf') && !base.startsWith('mmproj-');
}

function sumKnownSizes(files: HuggingFaceFile[]): number | null {
  let total = 0;
  for (const file of files) {
    if (file.size == null) {
      return null;
    }
    total += file.size;
  }
  return total;
}

function validateHuggingFaceRef(repoId: string, quant: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoId)) {
    throw new Error(`Invalid Hugging Face repo id: ${repoId}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(quant)) {
    throw new Error(`Invalid Hugging Face quant: ${quant}`);
  }
}
