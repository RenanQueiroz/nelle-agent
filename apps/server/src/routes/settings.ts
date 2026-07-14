import {z} from 'zod';

import {
  HOST_TOOLS_DESCRIPTION,
  HOST_TOOLS_WARNING,
  preferencesSchema,
} from '../contracts/contracts.ts';
import {settingsPatchSchema, type SettingsValues} from '../contracts/settings.ts';
import {SESSION_RESETTING_SETTINGS_SLUGS} from '../contracts/settingsKeys.ts';
import {json, type Router} from '../http/router';
import type {RouteDeps} from './deps';

const hostToolSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
});

/**
 * The settings groups, plus the two that are not groups.
 *
 * A server setting exists in exactly one place -- `SETTINGS_REGISTRY` -- and the routes are
 * registered by iterating it, which is why a slug collision is a loud failure at boot rather
 * than a route that silently never matches. Registering per slug rather than behind a
 * `/api/settings/:group` parameter is also what keeps `schema`, `preferences` and `host-tools`
 * from being swallowed by it.
 *
 * Those three are hand-written for the two reasons the registry cannot express: a favourite is
 * a *set*, and host tools are an acknowledgement gate on an unsandboxed shell -- `enabled`
 * without `acknowledged` is refused, which is not a boolean field, it is a rule.
 */
export function registerSettingsRoutes(router: Router, deps: RouteDeps): void {
  const {store, hostTools, preferences, settings, pi} = deps;

  router.get('/api/settings/host-tools', async () =>
    json({
      hostTools: hostTools.getSettings(),
      // The server's own sentence. A security warning each client writes for itself is
      // the one copy you least want drifting.
      warning: HOST_TOOLS_WARNING,
      description: HOST_TOOLS_DESCRIPTION,
    }),
  );

  // Favorites follow the user, not the browser profile that set them.
  router.get('/api/settings/preferences', async () => {
    const state = await store.getState();
    return json(preferences.getPreferences(state.models.map(model => model.id)));
  });

  router.patch('/api/settings/preferences', async ctx => {
    const body = preferencesSchema.parse(await ctx.body());
    const saved = preferences.updatePreferences(body);
    const state = await store.getState();
    const known = new Set(state.models.map(model => model.id));
    return json({...saved, favoriteModelIds: saved.favoriteModelIds.filter(id => known.has(id))});
  });

  // The settings schema is served for the same reason the slash-command registry
  // is: a second client renders the fields without carrying a copy of fifteen
  // labels, and a new setting ships without a client release.
  router.get('/api/settings/schema', async () => json({sections: settings.groups}));

  // One route pair per registry group. Registering them from the registry rather
  // than behind a `/api/settings/:group` parameter keeps `schema`, `preferences`
  // and `host-tools` from being swallowed by it, and makes a slug collision a
  // loud failure at boot instead of a route that silently never matches.
  for (const group of settings.groups) {
    const patchSchema = settingsPatchSchema(group);
    // Pi bakes the system prompt into a session at construction, so a change to
    // the custom instructions reaches an open conversation only if the session it
    // would reuse is thrown away. `PATCH /api/settings/host-tools` already does
    // exactly this, for exactly the same reason.
    const resetsSessions = SESSION_RESETTING_SETTINGS_SLUGS.includes(group.slug);
    router.get(`/api/settings/${group.slug}`, async () => json(settings.getGroup(group.slug)));
    router.patch(`/api/settings/${group.slug}`, async ctx => {
      const body = patchSchema.parse(await ctx.body()) as SettingsValues;
      const saved = settings.updateGroup(group.slug, body);
      if (resetsSessions) {
        pi.resetSession();
      }
      return json(saved);
    });
  }

  router.patch('/api/settings/host-tools', async ctx => {
    const body = hostToolSettingsSchema.parse(await ctx.body());
    let hostToolSettings;
    try {
      hostToolSettings = hostTools.updateSettings(body);
    } catch (error) {
      return json(
        {
          error: {
            code: 'host_tools_acknowledgement_required',
            message:
              error instanceof Error
                ? error.message
                : 'Host tools must be acknowledged before they can be enabled.',
          },
        },
        400,
      );
    }
    pi.resetSession();
    return json({
      hostTools: hostToolSettings,
      warning: HOST_TOOLS_WARNING,
      description: HOST_TOOLS_DESCRIPTION,
    });
  });
}
