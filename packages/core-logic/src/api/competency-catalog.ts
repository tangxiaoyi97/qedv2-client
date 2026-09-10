import type {
  CompetencyArea, CompetencyAreaCode, CompetencyCatalog, CompetencyComment,
  CompetencyContextBlock, CompetencyDefinition, CompetencyFootnote, CompetencyGroup,
  CompetencyLocale, CompetencyText,
} from '../model/competency-catalog.js';
import { normalizeCompetencyCode } from '../model/competency-catalog.js';
import { CoreProtocolError } from './types.js';

const AREA_CODES = new Set<CompetencyAreaCode>(['AG', 'FA', 'AN', 'WS']);
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

function invalid(field: string): never {
  throw new CoreProtocolError('CORE_COMPETENCY_CATALOG_INVALID', `Core returned an invalid competency catalog (${field}).`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid(field);
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid(field);
  return value;
}

/** Validate every displayed field and reference; never publish a partial catalog. */
export function parseCompetencyCatalog(wire: unknown, expectedLocale?: CompetencyLocale): CompetencyCatalog {
  let textBudget = 2_000_000;
  function text(value: unknown, field: string, max = 32_000, empty = false): string {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return invalid(field);
    textBudget -= value.length;
    if (textBudget < 0) return invalid('size');
    return value;
  }
  const root = object(wire, 'root');
  if (root.schemaVersion !== 1 || root.id !== 'srdp-mathematics-ahs'
    || root.textFormat !== 'markdown+latex') return invalid('schema');
  if ((root.locale !== 'de' && root.locale !== 'en')
    || (expectedLocale !== undefined && root.locale !== expectedLocale)) return invalid('locale');
  const version = text(root.version, 'version', 7);
  if (!MONTH.test(version)) return invalid('version');
  const sourceWire = object(root.source, 'source');
  const url = text(sourceWire.url, 'source.url', 4_096);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || url !== url.trim() || /[\s\\]/u.test(url)) return invalid('source.url');
  } catch { return invalid('source.url'); }
  const sha256 = text(sourceWire.sha256, 'source.sha256', 64);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) return invalid('source.sha256');
  const sourcePageCount = sourceWire.pageCount;
  if (typeof sourcePageCount !== 'number' || !Number.isInteger(sourcePageCount) || sourcePageCount < 1 || sourcePageCount > 1_000) {
    return invalid('source.pageCount');
  }
  const pageCount: number = sourcePageCount;
  function pages(value: unknown): number[] {
    const result = list(value, 'pages', 32, 1).map((page) => {
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) return invalid('pages');
      return page;
    });
    if (new Set(result).size !== result.length) return invalid('duplicate pages');
    return result;
  }
  function paragraph(value: unknown): CompetencyText {
    const item = object(value, 'text block');
    return { text: text(item.text, 'text'), pages: pages(item.pages) };
  }
  function refs(value: unknown, field: string): string[] {
    const result = list(value, field, 16, 1).map((ref) => {
      const marker = text(ref, field, 8);
      if (!/^\*{1,8}$/u.test(marker)) return invalid(field);
      return marker;
    });
    if (new Set(result).size !== result.length) return invalid(field);
    return result;
  }
  function group(value: unknown, area: CompetencyAreaCode): CompetencyGroup {
    const item = object(value, 'group');
    const code = text(item.code, 'group.code', 16);
    if (!new RegExp(`^${area} [1-9]\\d?$`, 'u').test(code)) return invalid('group.code');
    const definitions = list(item.competencies, 'competencies', 128, 1).map((value): CompetencyDefinition => {
      const entry = object(value, 'competency');
      const competencyCode = text(entry.code, 'competency.code', 32);
      if (normalizeCompetencyCode(competencyCode) !== competencyCode
        || !competencyCode.startsWith(`${code}.`)) return invalid('competency.code');
      return {
        code: competencyCode, ...paragraph(entry),
        ...(entry.footnoteRefs === undefined ? {} : { footnoteRefs: refs(entry.footnoteRefs, 'footnoteRefs') }),
      };
    });
    const codes = new Set(definitions.map((entry) => entry.code));
    if (codes.size !== definitions.length) return invalid('duplicate competency');
    function scopedCodes(value: unknown): string[] {
      const result = list(value, 'competencyCodes', 128, 1).map((code) => {
        if (typeof code !== 'string' || !codes.has(code)) return invalid('competencyCodes');
        return code;
      });
      if (new Set(result).size !== result.length) return invalid('duplicate competencyCodes');
      return result;
    }
    const comments = list(item.comments, 'comments', 128).map((value): CompetencyComment => {
      const entry = object(value, 'comment');
      return {
        ...paragraph(entry),
        ...(entry.competencyCodes === undefined ? {} : { competencyCodes: scopedCodes(entry.competencyCodes) }),
      };
    });
    const footnotes = list(item.footnotes, 'footnotes', 16).map((value): CompetencyFootnote => {
      const entry = object(value, 'footnote');
      const marker = refs([entry.marker], 'footnote.marker')[0]!;
      const note: CompetencyFootnote = { marker, ...paragraph(entry), competencyCodes: scopedCodes(entry.competencyCodes) };
      if (entry.effectiveFrom !== undefined) {
        const effective = object(entry.effectiveFrom, 'effectiveFrom');
        const date = text(effective.date, 'effectiveFrom.date', 7);
        if (!MONTH.test(date)) return invalid('effectiveFrom.date');
        note.effectiveFrom = { examSession: text(effective.examSession, 'effectiveFrom.examSession', 256), date };
      }
      return note;
    });
    if (new Set(footnotes.map((note) => note.marker)).size !== footnotes.length) return invalid('duplicate footnote');
    // Check both directions so an accidentally assigned footnote cannot alter
    // the meaning or effective date of a neighbouring competency.
    for (const entry of definitions) {
      for (const marker of entry.footnoteRefs ?? []) {
        if (!footnotes.some((note) => note.marker === marker && note.competencyCodes.includes(entry.code))) {
          return invalid('unresolved footnote');
        }
      }
    }
    for (const note of footnotes) {
      if (note.competencyCodes.some((code) => !definitions.find((entry) => entry.code === code)?.footnoteRefs?.includes(note.marker))) {
        return invalid('unreferenced footnote');
      }
    }
    return { code, title: text(item.title, 'group.title'), pages: pages(item.pages), competencies: definitions, comments, footnotes };
  }
  const areas = list(root.areas, 'areas', 4, 4).map((value): CompetencyArea => {
    const area = object(value, 'area');
    if (typeof area.code !== 'string' || !AREA_CODES.has(area.code as CompetencyAreaCode)) return invalid('area.code');
    const code = area.code as CompetencyAreaCode;
    const groups = list(area.groups, 'groups', 32, 1).map((value) => group(value, code));
    if (new Set(groups.map((entry) => entry.code)).size !== groups.length) return invalid('duplicate group');
    return { code, title: text(area.title, 'area.title'), introduction: list(area.introduction, 'introduction', 128).map(paragraph), groups };
  });
  if (new Set(areas.map((area) => area.code)).size !== areas.length) return invalid('duplicate area');
  const contexts = object(root.contexts, 'contexts');
  const blocks = list(contexts.blocks, 'contexts.blocks', 256).map((value): CompetencyContextBlock => {
    const block = object(value, 'context block');
    if (block.type === 'paragraph' || block.type === 'heading') return { type: block.type, ...paragraph(block) };
    if (block.type === 'equation') return { type: block.type, latex: text(block.latex, 'latex'), pages: pages(block.pages) };
    if (block.type !== 'table') return invalid('context block.type');
    const headers = list(block.headers, 'table.headers', 32).map((header) => text(header, 'table.header', 32_000, true));
    const rows = list(block.rows, 'table.rows', 256, 1).map((row) => (
      list(row, 'table.row', 32, 1).map((cell) => text(cell, 'table.cell', 32_000, true))
    ));
    const columns = rows[0]!.length;
    if ((headers.length !== 0 && headers.length !== columns) || rows.some((row) => row.length !== columns)) return invalid('table width');
    return { type: block.type, headers, rows, pages: pages(block.pages) };
  });
  return {
    schemaVersion: 1, id: 'srdp-mathematics-ahs', locale: root.locale, version,
    textFormat: 'markdown+latex', title: text(root.title, 'title'), subtitle: text(root.subtitle, 'subtitle'),
    source: { url, sha256, pageCount, versionLabel: text(sourceWire.versionLabel, 'source.versionLabel') },
    areas, contexts: { title: text(contexts.title, 'contexts.title'), blocks },
  };
}
