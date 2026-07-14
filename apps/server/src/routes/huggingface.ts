import {z} from 'zod';

import {json, type Router} from '../http/router';
import type {RouteDeps} from './deps';
import {writePresetAndReloadRouter} from './models';

const useHuggingFaceModelSchema = z.object({
  repoId: z.string().min(1),
  quant: z.string().min(1),
  name: z.string().optional(),
});

/**
 * Importing a model from Hugging Face, which is the only way a model enters the catalog.
 *
 * The import is an `hf-repo` entry and nothing else: llama.cpp owns the download, and it
 * resumes, etag-caches, fetches shards in parallel, and wires up the accessories it finds
 * beside the weights. So `use` writes a `models.ini` section and reloads the router --
 * a catalog mutation, which is why it borrows the models module's own.
 */
export function registerHuggingFaceRoutes(router: Router, deps: RouteDeps): void {
  const {store, modelCache, llama, hf} = deps;

  router.get('/api/huggingface/search', async ctx =>
    json({results: await hf.searchGgufModels(ctx.query.q ?? '')}),
  );

  router.post('/api/huggingface/use', async ctx => {
    const body = useHuggingFaceModelSchema.parse(await ctx.body());
    const model = await hf.useHuggingFaceGguf(body);
    await writePresetAndReloadRouter(llama, store, modelCache);
    return json({model});
  });
}
