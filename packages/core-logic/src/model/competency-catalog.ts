/** The versioned official curriculum supplied by the selected question bank. */
export type CompetencyLocale = 'de' | 'en';
export type CompetencyAreaCode = 'AG' | 'FA' | 'AN' | 'WS';

export interface CompetencyText {
  text: string;
  pages: number[];
}

export interface CompetencyDefinition extends CompetencyText {
  code: string;
  footnoteRefs?: string[];
}

export interface CompetencyComment extends CompetencyText {
  /** Absent for a group-wide comment. */
  competencyCodes?: string[];
}

export interface CompetencyFootnote extends CompetencyText {
  marker: string;
  competencyCodes: string[];
  effectiveFrom?: { examSession: string; date: string };
}

export interface CompetencyGroup {
  code: string;
  title: string;
  pages: number[];
  competencies: CompetencyDefinition[];
  comments: CompetencyComment[];
  footnotes: CompetencyFootnote[];
}

export interface CompetencyArea {
  code: CompetencyAreaCode;
  title: string;
  introduction: CompetencyText[];
  groups: CompetencyGroup[];
}

export type CompetencyContextBlock =
  | ({ type: 'paragraph' | 'heading' } & CompetencyText)
  | { type: 'equation'; latex: string; pages: number[] }
  | { type: 'table'; headers: string[]; rows: string[][]; pages: number[] };

export interface CompetencyCatalog {
  schemaVersion: 1;
  id: 'srdp-mathematics-ahs';
  locale: CompetencyLocale;
  version: string;
  textFormat: 'markdown+latex';
  title: string;
  subtitle: string;
  source: { url: string; sha256: string; pageCount: number; versionLabel: string };
  areas: CompetencyArea[];
  contexts: { title: string; blocks: CompetencyContextBlock[] };
}

export interface CompetencyDetails {
  catalog: CompetencyCatalog;
  area: CompetencyArea;
  group: CompetencyGroup;
  competency: CompetencyDefinition;
  comments: CompetencyComment[];
  footnotes: CompetencyFootnote[];
}

/** Accept the compact codes used in older question banks without guessing. */
export function normalizeCompetencyCode(code: string): string | null {
  if (code.length > 32) return null;
  const match = /^(AG|FA|AN|WS)\s*([1-9]\d?)\.([1-9]\d?)$/iu.exec(code.trim());
  return match ? `${match[1]!.toUpperCase()} ${match[2]}.${match[3]}` : null;
}

export function lookupCompetency(catalog: CompetencyCatalog, code: string): CompetencyDetails | null {
  const normalized = normalizeCompetencyCode(code);
  if (!normalized) return null;
  for (const area of catalog.areas) {
    for (const group of area.groups) {
      const competency = group.competencies.find((entry) => entry.code === normalized);
      if (!competency) continue;
      return {
        catalog, area, group, competency,
        comments: group.comments.filter((comment) => (
          !comment.competencyCodes || comment.competencyCodes.includes(normalized)
        )),
        footnotes: group.footnotes.filter((footnote) => (
          competency.footnoteRefs?.includes(footnote.marker)
          && footnote.competencyCodes.includes(normalized)
        )),
      };
    }
  }
  return null;
}
