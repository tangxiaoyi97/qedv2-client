import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownView from '../src/shared/MarkdownView.vue';

const reported = String.raw`1. **Ableitungsregel verwenden:** Für $c\cdot x^3$ gilt
   $$\big(c\cdot x^3\big)'=3c\cdot x^2.$$$
   Außerdem ist $h(x)=a\cdot x^2$.

2. Für $f(x)=a\cdot x^3$ gilt:
   $$f'(x)=3a\cdot x^2=3\cdot h(x).$$
   **Zuordnung: 1) → A**

3. Zuerst $3\cdot g(x)$ bilden.`;

describe('MarkdownView math and structure', () => {
  it('renders the reported derivative explanation without a code fallback or restarted steps', () => {
    const wrapper = mount(MarkdownView, { props: { source: reported } });
    expect(wrapper.find('.q-math-fallback').exists()).toBe(false);
    expect(wrapper.findAll('ol')).toHaveLength(1);
    expect(wrapper.findAll('ol > li')).toHaveLength(3);
    expect(wrapper.findAll('.q-md__mathblock')).toHaveLength(2);
    const formulas = wrapper.findAll('annotation').map((node) => node.text());
    expect(formulas).toContain(String.raw`\big(c\cdot x^3\big)'=3c\cdot x^2.`);
    expect(wrapper.text()).toContain('Außerdem ist');
    expect(wrapper.text()).toContain('Zuordnung: 1) → A');
  });

  it('renders standard inline/display delimiters, including formulas inside bold and nested lists', () => {
    const source = String.raw`**Es gilt \(x^2\).**

3. Äußere Regel
   - Innere Regel: \(2x\)
   - Ableitung:
     \[
     \frac{a+b}{c+d}
     \]

Danach folgt
$$
\sqrt{x+1}
$$`;
    const wrapper = mount(MarkdownView, { props: { source } });
    expect(wrapper.get('ol').attributes('start')).toBe('3');
    expect(wrapper.find('strong .katex').exists()).toBe(true);
    expect(wrapper.findAll('ol > li > ul > li')).toHaveLength(2);
    expect(wrapper.findAll('.q-md__mathblock')).toHaveLength(2);
    expect(wrapper.findAll('.katex')).toHaveLength(4);
    expect(wrapper.find('.q-math-fallback').exists()).toBe(false);
  });

  it('keeps formulas literal in code and renders unsafe HTML as text', () => {
    const source = ['`$x$` and ``\\(y\\)``', '', '```tex', '$$z$$', '\\[w\\]', '</code><img src=x onerror=alert(1)>', '```', '', '    $a$'].join('\n');
    const wrapper = mount(MarkdownView, { props: { source } });
    expect(wrapper.find('.katex').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.findAll('pre')).toHaveLength(2);
    expect(wrapper.text()).toContain('$$z$$');
    expect(wrapper.text()).toContain('onerror=alert(1)');
  });
});
