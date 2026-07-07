import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

import type {AppPaths} from './paths';
import type {
  ConfiguredModel,
  HuggingFaceFile,
  HuggingFaceModelResult,
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

    return detailed.filter(result => result.files.length > 0);
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

  private async getModelInfo(
    repoId: string,
    fallback: HfModelListItem,
  ): Promise<HuggingFaceModelResult> {
    const response = await fetch(
      `https://huggingface.co/api/models/${repoId}`,
    );
    if (!response.ok) {
      return {
        id: repoId,
        author: fallback.author,
        downloads: fallback.downloads,
        likes: fallback.likes,
        tags: fallback.tags ?? [],
        files: [],
      };
    }

    const info = (await response.json()) as HfModelInfo;
    return {
      id: info.id,
      author: info.author,
      downloads: info.downloads,
      likes: info.likes,
      tags: info.tags ?? [],
      files: extractGgufFiles(info),
    };
  }
}

function extractGgufFiles(info: HfModelInfo): HuggingFaceFile[] {
  return (info.siblings ?? [])
    .filter(file => file.rfilename.toLowerCase().endsWith('.gguf'))
    .map(file => ({
      filename: file.rfilename,
      size: file.size ?? null,
    }))
    .sort((a, b) => {
      const bySize =
        (a.size ?? Number.MAX_SAFE_INTEGER) -
        (b.size ?? Number.MAX_SAFE_INTEGER);
      return bySize === 0 ? a.filename.localeCompare(b.filename) : bySize;
    });
}
