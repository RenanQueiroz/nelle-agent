import fs from 'node:fs/promises';

import {runCommand} from './process';
import {
  acceptedModelParamKeys,
  llamaOptionCatalogue,
  type LlamaOptionCatalogue,
} from './contracts/modelParams.ts';

/**
 * `llama-server --help`, parsed once per binary.
 *
 * The catalogue is what stands between the params editor and a runtime that will
 * not start: an unknown key in `models.ini` makes llama-server exit before it
 * serves anything. It is read from the binary rather than carried in Nelle,
 * because a copy of llama.cpp's 252 options goes stale on the next upgrade.
 */
export class LlamaOptionCatalogueCache {
  #entry: {signature: string; catalogue: LlamaOptionCatalogue} | null = null;

  constructor(private readonly resolveBinaryPath: () => Promise<string | null>) {}

  async get(): Promise<LlamaOptionCatalogue> {
    const binaryPath = await this.resolveBinaryPath();
    const signature = binaryPath ? await binarySignature(binaryPath) : null;
    if (!signature) {
      // No binary installed, or it vanished. Nothing to validate against.
      this.#entry = null;
      return UNAVAILABLE;
    }
    if (this.#entry?.signature === signature) {
      return this.#entry.catalogue;
    }
    const catalogue = await readCatalogue(binaryPath!);
    this.#entry = {signature, catalogue};
    return catalogue;
  }

  /**
   * The accept-set, or `undefined` when the catalogue is unavailable. `undefined`
   * means "skip the unknown-key check": refusing to save a parameter because
   * Nelle could not run a binary would be worse than the typo.
   */
  async acceptedKeys(): Promise<Set<string> | undefined> {
    const catalogue = await this.get();
    return catalogue.available ? acceptedModelParamKeys(catalogue.options) : undefined;
  }
}

const UNAVAILABLE: LlamaOptionCatalogue = {available: false, options: []};

/** Path, size and mtime: a rebuilt binary at the same path parses again. */
async function binarySignature(binaryPath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(binaryPath);
    return `${binaryPath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

async function readCatalogue(binaryPath: string): Promise<LlamaOptionCatalogue> {
  try {
    return llamaOptionCatalogue(await runCommand(binaryPath, ['--help']));
  } catch {
    // An external binary that will not run, or one built without `--help`.
    return UNAVAILABLE;
  }
}
