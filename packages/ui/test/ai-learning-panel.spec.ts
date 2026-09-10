import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import AiLearningPanel from '../src/practice/AiLearningPanel.vue';

describe('AiLearningPanel', () => {
  it('renders formulas in every diagnosis field without exposing markup', () => {
    const wrapper = mount(AiLearningPanel, {
      props: {
        stage: 'diagnosis',
        diagnosis: {
          errorCode: 'algebra',
          reason: String.raw`Beim Ableiten von \(a\cdot x^3\) entsteht der Faktor **3**, nicht 9.`,
          evidence: String.raw`\(f'(x)\) → \(9\cdot h(x)\)`,
          correctionPrompt: String.raw`Wende die Potenzregel auf \(f(x)=a\cdot x^3\) an und verwende \(h(x)\).`,
          confidence: 0.99,
          advisoryOnly: true,
          evidenceVerified: true,
        },
      },
    });
    expect(wrapper.findAll('.katex')).toHaveLength(5);
    expect(wrapper.find('.q-math-fallback').exists()).toBe(false);
    expect(wrapper.get('strong').text()).toBe('3');
    expect(wrapper.get('blockquote').findAll('.katex')).toHaveLength(2);
    expect(wrapper.get('.q-learning__action').findAll('.katex')).toHaveLength(2);
    expect(wrapper.find('p .q-md').exists()).toBe(false);
  });

  it('renders next-step math safely and keeps unverified evidence hidden', async () => {
    const wrapper = mount(AiLearningPanel, {
      props: {
        stage: 'hint', markdown: 'Nutze die Potenzregel.',
        nextAction: 'Vergleiche **$h(x)$**. <img src=x onerror=alert(1)>',
      },
    });
    expect(wrapper.get('.q-learning__action').findAll('.katex')).toHaveLength(1);
    expect(wrapper.get('.q-learning__action').find('img').exists()).toBe(false);
    expect(wrapper.get('.q-learning__action').text()).toContain('<img src=x onerror=alert(1)>');
    await wrapper.setProps({ stage: 'diagnosis', diagnosis: {
      errorCode: 'unknown', reason: 'Kein sicherer Beleg.', evidence: '$x=9$',
      correctionPrompt: 'Prüfe den Ansatz.', confidence: 0.1,
      evidenceVerified: false, advisoryOnly: true,
    } });
    expect(wrapper.find('blockquote').exists()).toBe(false);
  });

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

  it('shows useful diagnosis without offering a correction or second attempt', () => {
    const wrapper = mount(AiLearningPanel, {
      props: {
        stage: 'diagnosis',
        diagnosis: {
          errorCode: 'algebra',
          evidence: '2x = 6 → x = 2',
          reason: 'Beim Teilen wurde der Faktor vertauscht.',
          correctionPrompt: 'Beim Teilen durch 2 gilt 6 ÷ 2 = 3.',
          confidence: 0.9,
          advisoryOnly: true,
          evidenceVerified: true,
        },
        aiGenerated: true,
      },
    });
    expect(wrapper.text()).toContain('Algebraischer Schritt');
    expect(wrapper.text()).toContain('2x = 6');
    expect(wrapper.text()).toContain('6 ÷ 2 = 3');
    expect(wrapper.find('.q-learning__actions .q-btn').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('korrigieren');
    expect(wrapper.emitted('correct')).toBeUndefined();
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

  it('offers setup instead of a paid request without adding a correction action', async () => {
    const wrapper = mount(AiLearningPanel, {
      props: { stage: 'hint', aiGenerated: true, needsSetup: true },
    });
    expect(wrapper.text()).toContain('KI einrichten');
    expect(wrapper.text()).not.toContain('Hinweis 1');
    await wrapper.get('.q-learning__actions .q-btn').trigger('click');
    expect(wrapper.emitted('setup')).toHaveLength(1);
    expect(wrapper.emitted('requestHint')).toBeUndefined();
    await wrapper.setProps({ stage: 'diagnosis', aiGenerated: false, needsSetup: false });
    expect(wrapper.get('h3').text()).toBe('Erklärung');
    expect(wrapper.text()).not.toContain('KI');
    expect(wrapper.text()).not.toContain('Korrektur');
    expect(wrapper.find('.q-learning__actions .q-btn').exists()).toBe(false);
    expect(wrapper.emitted('correct')).toBeUndefined();
  });

  it('can still request an explanation and dismiss it using shared controls', async () => {
    const wrapper = mount(AiLearningPanel, {
      props: { stage: 'diagnosis', aiGenerated: true, canRequestDiagnosis: true },
    });
    expect(wrapper.get('h3').text()).toBe('KI-Hilfe');
    await wrapper.get('.q-learning__actions .q-btn').trigger('click');
    expect(wrapper.emitted('requestDiagnosis')).toHaveLength(1);
    await wrapper.get('button[aria-label="KI-Hilfe schließen"]').trigger('click');
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
  });

  it('does not leave a retry request after the stage feature becomes unavailable', () => {
    const wrapper = mount(AiLearningPanel, {
      props: { stage: 'diagnosis', error: 'Nicht verfügbar.', canRequestDiagnosis: false },
    });
    expect(wrapper.find('.q-learning__error .q-btn').exists()).toBe(false);
  });
});
