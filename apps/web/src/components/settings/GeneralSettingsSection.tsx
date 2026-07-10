import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {NumberInput} from '@astryxdesign/core/NumberInput';
import {Selector} from '@astryxdesign/core/Selector';
import {Switch} from '@astryxdesign/core/Switch';
import {TextArea} from '@astryxdesign/core/TextArea';
import {Text, Heading} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';

import type {SettingsFieldSchema, SettingsGroupSchema, SettingsValues} from '../../api';
import {useSettingsStore} from '../../stores/settingsStore';
import {usePreferencesStore} from '../../stores/preferencesStore';
import {DISPLAY_PREFERENCE_FIELDS} from '../../../../../packages/shared/src/displayPreferences.ts';
import {estimatePromptTokens} from '../../../../../packages/shared/src/piContext.ts';

/**
 * Renders `GET /api/settings/schema`. Nothing here knows what a setting means.
 *
 * A field's label, help, bounds, options and default all arrive from the server,
 * so a new setting appears in this dialog without a line of client code -- which
 * is the whole reason the schema is served rather than bundled.
 */
export function GeneralSettingsSection({
  busyAction,
  onSaveSettingsGroup,
}: {
  busyAction: string | null;
  onSaveSettingsGroup: (slug: string) => void | Promise<void>;
}) {
  const schema = useSettingsStore(state => state.settingsSchema);
  const error = useSettingsStore(state => state.settingsError);

  if (schema.length === 0) {
    return <Text type="supporting">Loading settings…</Text>;
  }

  return (
    <VStack gap={4}>
      {error && <Banner status="error" title="Settings not saved" description={error} />}
      {schema.map((group, index) => (
        <VStack key={group.slug} gap={4}>
          {index > 0 && <Divider />}
          <SettingsGroupFields
            group={group}
            busyAction={busyAction}
            onSaveSettingsGroup={onSaveSettingsGroup}
          />
        </VStack>
      ))}
      <Divider />
      <DisplayPreferences />
    </VStack>
  );
}

/**
 * The toggles the client applies and the server stores, so they follow the user
 * to their phone. They have no Save button: a rendering preference is not worth
 * a spinner, so the switch flips and the server is told.
 */
function DisplayPreferences() {
  const preferences = usePreferencesStore();
  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={3}>Display</Heading>
        <Text type="supporting">
          How the transcript is rendered. Saved to your account, not this browser.
        </Text>
      </VStack>
      {DISPLAY_PREFERENCE_FIELDS.map(field => (
        <Switch
          key={field.key}
          label={field.label}
          description={field.help}
          value={preferences[field.key]}
          onChange={value => void preferences.toggle(field.key, value)}
          data-testid={`preference-${field.key}`}
        />
      ))}
    </VStack>
  );
}

function SettingsGroupFields({
  group,
  busyAction,
  onSaveSettingsGroup,
}: {
  group: SettingsGroupSchema;
  busyAction: string | null;
  onSaveSettingsGroup: (slug: string) => void | Promise<void>;
}) {
  const draft = useSettingsStore(state => state.settingsDrafts[group.slug]);
  const action = `settings:${group.slug}`;

  // The values have not arrived yet. Rendering a field at its schema default
  // would show the user a value the server may not hold.
  if (!draft) {
    return <Text type="supporting">Loading {group.title.toLowerCase()}…</Text>;
  }

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={3}>{group.title}</Heading>
        {group.description && <Text type="supporting">{group.description}</Text>}
      </VStack>
      {group.fields.map(field => (
        <SettingsFieldControl key={field.key} slug={group.slug} field={field} draft={draft} />
      ))}
      <HStack gap={2}>
        <Button
          label={busyAction === action ? 'Saving…' : 'Save'}
          isDisabled={busyAction !== null}
          onClick={() => void onSaveSettingsGroup(group.slug)}
          data-testid={`save-settings-${group.slug}`}
        />
      </HStack>
    </VStack>
  );
}

function SettingsFieldControl({
  slug,
  field,
  draft,
}: {
  slug: string;
  field: SettingsFieldSchema;
  draft: SettingsValues;
}) {
  const setSettingsField = useSettingsStore(state => state.setSettingsField);
  const onChange = (value: string | number | boolean) => setSettingsField(slug, field.key, value);
  const testId = `setting-${slug}-${field.key}`;

  switch (field.type) {
    case 'text':
      return (
        <TextInput
          label={field.label}
          description={field.help}
          value={String(draft[field.key] ?? field.default)}
          onChange={onChange}
          data-testid={testId}
        />
      );
    case 'textarea': {
      const value = String(draft[field.key] ?? field.default);
      return (
        <VStack gap={1}>
          <TextArea
            label={field.label}
            description={field.help}
            value={value}
            maxLength={field.maxLength}
            rows={6}
            onChange={onChange}
            data-testid={testId}
          />
          {/* A pure helper, not a round trip: Pi counts four characters to a
              token, and this text costs that on every prompt of every turn. */}
          {field.tokenCost && value.length > 0 && (
            <Text type="supporting" color="secondary">
              About {estimatePromptTokens(value).toLocaleString()} tokens of every prompt.
            </Text>
          )}
        </VStack>
      );
    }
    case 'number':
      return (
        <NumberInput
          label={field.label}
          description={field.help}
          value={Number(draft[field.key] ?? field.default)}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={onChange}
          data-testid={testId}
        />
      );
    case 'boolean':
      return (
        <Switch
          label={field.label}
          description={field.help}
          value={Boolean(draft[field.key] ?? field.default)}
          onChange={onChange}
          data-testid={testId}
        />
      );
    case 'select':
      return (
        <Selector
          label={field.label}
          description={field.help}
          options={field.options}
          value={String(draft[field.key] ?? field.default)}
          onChange={onChange}
          data-testid={testId}
        />
      );
  }
}
