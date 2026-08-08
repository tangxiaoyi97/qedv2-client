import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent } from 'vue';

import SettingsCard from '../src/routes/settings/SettingsCard.vue';
import SettingsRow from '../src/routes/settings/SettingsRow.vue';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('settings control-panel components', () => {
  it('connects card and row labels to their controls', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const app = createApp(defineComponent({
      components: { SettingsCard, SettingsRow },
      template: `
        <SettingsCard title="Darstellung">
          <template #action><button type="button">Aktualisieren</button></template>
          <SettingsRow label="Aussehen" description="Optionaler Hinweis">
            <template #default="{ labelId }">
              <div role="radiogroup" :aria-labelledby="labelId">
                <button type="button" role="radio" aria-checked="true">Hell</button>
              </div>
            </template>
          </SettingsRow>
        </SettingsCard>
      `,
    }));

    app.mount(host);

    const card = host.querySelector('section');
    const cardTitle = host.querySelector('h2');
    expect(card?.getAttribute('aria-labelledby')).toBe(cardTitle?.id);

    const rowLabel = host.querySelector('.q-settings-row__label');
    const radioGroup = host.querySelector('[role="radiogroup"]');
    expect(radioGroup?.getAttribute('aria-labelledby')).toBe(rowLabel?.id);
    expect(host.textContent).toContain('Optionaler Hinweis');

    app.unmount();
  });

  it('renders status and danger semantics without changing slot placement', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const app = createApp(defineComponent({
      components: { SettingsCard, SettingsRow },
      template: `
        <SettingsCard>
          <SettingsRow label="Abmelden" tone="danger">
            <template #status><span role="status">Bereit</span></template>
            <button type="button">Abmelden</button>
          </SettingsRow>
        </SettingsCard>
      `,
    }));

    app.mount(host);

    expect(host.querySelector('.q-settings-row--danger')).not.toBeNull();
    expect(host.querySelector('.q-settings-row__status [role="status"]')?.textContent).toBe('Bereit');
    expect(host.querySelector('.q-settings-row__control button')?.textContent).toBe('Abmelden');

    app.unmount();
  });
});
