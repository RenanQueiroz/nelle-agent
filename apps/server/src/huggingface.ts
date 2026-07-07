import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

import type {AppPaths} from './paths';
import type {
  ConfiguredModel,
  HuggingFaceFile,
  HuggingFaceModelResult,
  HuggingFaceQuant,
} from './types';
import {AppStore, slugify} from './store';

type HfModelListItem = {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
};

type HfModelInfo = HfModelListItem & {
  siblings?: Array<{
    rfilename: string;
    size?: number;
  }>;
};

export class HuggingFaceService {
  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
  ) {}

  async searchGgufModels(query: string): Promise<HuggingFaceModelResult[]> {
    const search = query.trim() || 'gguf';
    const url = new URL('https://huggingface.co/api/models');
    url.searchParams.set('search', search);
    url.searchParams.set('filter', 'gguf');
    url.searchParams.set('sort', 'downloads');
    url.searchParams.set('direction', '-1');
    url.searchParams.set('limit', '12');

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

  async downloadGguf(input: {
    repoId: string;
    filename: string;
    name?: string;
  }): Promise<ConfiguredModel> {
    if (!input.filename.toLowerCase().endsWith('.gguf')) {
      throw new Error('Only GGUF files can be downloaded.');
    }

    const safeRepo = slugify(input.repoId);
    const targetDir = path.join(this.paths.modelsDir, safeRepo);
    const targetPath = path.join(targetDir, path.basename(input.filename));
    await fs.mkdir(targetDir, {recursive: true});

    const encodedFile = input.filename.split('/').map(encodeURIComponent).join('/');
    const url = `https://huggingface.co/${input.repoId}/resolve/main/${encodedFile}?download=true`;
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const tmpPath = `${targetPath}.part`;
    const file = await fs.open(tmpPath, 'w');
    await pipeline(Readable.fromWeb(response.body as any), file.createWriteStream());
    await fs.rename(tmpPath, targetPath);

    return this.store.addLocalModel({
      name: input.name ?? `${input.repoId} ${path.basename(input.filename, '.gguf')}`,
      modelPath: targetPath,
      source: 'huggingface',
      repoId: input.repoId,
      filename: input.filename,
    });
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

  private async getModelInfo(
    repoId: string,
    fallback: HfModelListItem,
  ): Promise<HuggingFaceModelResult> {
    const response = await fetch(`https://huggingface.co/api/models/${repoId}`);
    if (!response.ok) {
      return {
        id: repoId,
        author: fallback.author,
        downloads: fallback.downloads,
        likes: fallback.likes,
        tags: fallback.tags ?? [],
        files: [],
        quants: [],
      };
    }

    const info = (await response.json()) as HfModelInfo;
    const files = extractGgufFiles(info);
    return {
      id: info.id,
      author: info.author,
      downloads: info.downloads,
      likes: info.likes,
      tags: info.tags ?? [],
      files,
      quants: extractGgufQuants(files),
    };
  }
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
