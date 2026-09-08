/** Browser assertions shared by the isolated visual rehearsal and route QA. */
import assert from 'node:assert/strict';

export async function assertSettingsGeometry(page) {
  const report = await page.evaluate(() => {
    const visible = (element) => element.getBoundingClientRect().width > 0;
    const collect = (selector) => [...document.querySelectorAll(selector)].filter(visible).map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        text: element.textContent?.trim().slice(0, 60),
        width: rect.width, height: rect.height,
        top: style.paddingTop, right: style.paddingRight,
        bottom: style.paddingBottom, left: style.paddingLeft,
        font: style.fontSize, line: style.lineHeight, radius: style.borderRadius,
      };
    });
    return {
      width: innerWidth,
      overflow: [...document.querySelectorAll('.q-settings-panel *')].filter(visible).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map((element) => ({ class: element.className, text: element.textContent?.trim().slice(0, 60) })),
      rows: collect('.q-settings-row, .q-settings-card__header, .q-settings-card__footer, .settings__vrow, .ai-settings__editor-actions, .ai-settings__privacy, .desktop-settings__subsection'),
      labels: collect('.q-settings-row__label, .q-settings-card__title, .settings__label, .desktop-settings__subheading'),
      fields: collect('input.q-settings-field, select.q-settings-field'),
      buttons: collect('.q-settings-panel .q-btn'),
      segments: collect('.q-settings-segments, .q-settings-segment'),
      cards: collect('.q-settings-card'),
      editorWidths: collect('#ai-credential-editor .q-settings-field').map((field) => field.width),
      selected: [...document.querySelectorAll('.settings__segment--on, .ai-settings__segment--on')].map((element) => ({
        background: getComputedStyle(element).backgroundColor,
        peerBackground: getComputedStyle(element.parentElement).backgroundColor,
      })),
    };
  });
  assert.deepEqual(report.overflow, [], 'No settings element may escape the viewport');
  for (const row of report.rows) {
    assert.deepEqual([row.top, row.right, row.bottom, row.left], ['12px', '16px', '12px', '16px'], `Row insets: ${row.text}`);
  }
  for (const label of report.labels) {
    assert.equal(label.font, '14px', `Label type: ${label.text}`);
    assert(label.height <= parseFloat(label.line) * 2 + 1, `Labels must not collapse to a vertical letter stack: ${label.text}`);
  }
  for (const field of report.fields) {
    assert.equal(field.height, 44, `Field height: ${field.text}`);
    assert.equal(field.font, '16px', `Field type: ${field.text}`);
    assert.equal(field.radius, '10px', `Field corners: ${field.text}`);
  }
  for (const button of report.buttons) {
    assert(button.width >= 99, `Shared button width floor: ${button.text}`);
    assert.equal(button.height, 44, `Button height: ${button.text}`);
    assert.equal(button.font, '14px', `Button type: ${button.text}`);
    assert.equal(button.radius, '10px', `Button corners: ${button.text}`);
  }
  for (const segment of report.segments) assert.equal(segment.height, 44, `Segment height: ${segment.text}`);
  for (const card of report.cards) assert.equal(card.radius, '14px', 'Card corners');
  for (const selected of report.selected) assert.notEqual(selected.background, selected.peerBackground, 'The first selected segment must be visibly active, too');
  if (report.editorWidths.length > 1) {
    assert(report.editorWidths.every((width) => Math.abs(width - report.editorWidths[0]) < 1), 'Provider, key and model fields share one width');
  }
  return report;
}
