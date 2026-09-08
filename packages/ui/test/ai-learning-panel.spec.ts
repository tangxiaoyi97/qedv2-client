import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import AiLearningPanel from '../src/practice/AiLearningPanel.vue';

describe('AiLearningPanel', () => {
  it('renders an authored hint without pretending it came from AI', () => {
    const wrapper = mount(AiLearningPanel, {
      props: {
        stage: 'hint',
        hintLevel: 1,
        markdown: 'Prüfe zuerst die **Bedingung**.',
        nextAction: 'Schreibe den ersten Schritt auf.',
        canRequestHint: true,
        aiGenerated: false,
      },
    });
    expect(wrapper.text()).toContain('Hinweis 1');
    expect(wrapper.find('strong').text()).toBe('Bedingung');
    expect(wrapper.text()).toContain('Schreibe den ersten Schritt auf');
    expect(wrapper.find('.q-aibadge').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('kann Fehler enthalten');
  });

  it('shows structured diagnosis and offers one immediate correction', async () => {
    const wrapper = mount(AiLearningPanel, {
      props: {
        stage: 'diagnosis',
        diagnosis: {
          errorCode: 'algebra',
          evidence: '2x = 6 → x = 2',
          reason: 'Beim Teilen wurde der Faktor vertauscht.',
          correctionPrompt: 'Korrigiere nur diesen Umformungsschritt.',
          confidence: 0.9,
          advisoryOnly: true,
          evidenceVerified: true,
        },
        aiGenerated: true,
        canCorrect: true,
      },
    });
    expect(wrapper.text()).toContain('Algebraischer Schritt');
    expect(wrapper.text()).toContain('2x = 6');
    expect(wrapper.text()).toContain('Korrigiere nur diesen');
    await wrapper.get('.q-learning__actions .q-btn').trigger('click');
    expect(wrapper.emitted('correct')).toHaveLength(1);
  });

  it('uses unique labelled-by ids and shared close controls', () => {
    const wrapper = mount(defineComponent({
      components: { AiLearningPanel },
      template: '<div><AiLearningPanel stage="hint" /><AiLearningPanel stage="hint" /></div>',
    }));
    const panels = wrapper.findAll('section');
    const firstId = panels[0]!.attributes('aria-labelledby');
    const secondId = panels[1]!.attributes('aria-labelledby');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(panels[0]!.get('.q-icon-btn').attributes('aria-label')).toBe('Hinweis schließen');
  });

  it('retries the same stage instead of silently switching actions', async () => {
    const hint = mount(AiLearningPanel, {
      props: { stage: 'hint', error: 'Offline.', canRequestHint: true },
    });
    await hint.get('.q-learning__error .q-btn').trigger('click');
    expect(hint.emitted('requestHint')).toHaveLength(1);
    expect(hint.emitted('requestDiagnosis')).toBeUndefined();

    const diagnosis = mount(AiLearningPanel, {
      props: { stage: 'diagnosis', error: 'Timeout.', canRequestDiagnosis: true },
    });
    await diagnosis.get('.q-learning__error .q-btn').trigger('click');
    expect(diagnosis.emitted('requestDiagnosis')).toHaveLength(1);
  });

  it('offers setup instead of a paid request and keeps correction independent of AI', async () => {
    const wrapper = mount(AiLearningPanel, {
      props: { stage: 'hint', aiGenerated: true, needsSetup: true },
    });
    expect(wrapper.text()).toContain('KI einrichten');
    expect(wrapper.text()).not.toContain('Hinweis 1');
    await wrapper.get('.q-learning__actions .q-btn').trigger('click');
    expect(wrapper.emitted('setup')).toHaveLength(1);
    expect(wrapper.emitted('requestHint')).toBeUndefined();
    await wrapper.setProps({ stage: 'diagnosis', aiGenerated: false, needsSetup: false, canCorrect: true });
    expect(wrapper.get('h3').text()).toBe('Korrektur');
    expect(wrapper.text()).not.toContain('KI');
    await wrapper.get('.q-learning__actions .q-btn').trigger('click');
    expect(wrapper.emitted('correct')).toHaveLength(1);
  });

  it('does not leave a retry request after the stage feature becomes unavailable', () => {
    const wrapper = mount(AiLearningPanel, {
      props: { stage: 'diagnosis', error: 'Nicht verfügbar.', canRequestDiagnosis: false },
    });
    expect(wrapper.find('.q-learning__error .q-btn').exists()).toBe(false);
  });
});
