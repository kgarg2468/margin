/** The caller-visible subset of an annotation used by both export formats. */
export type AnnotationExportInput = {
  authorName: string;
  type: string;
  visibility: string;
  anchor: {
    pageIndex: number;
    quote: string;
  };
  body: string;
  createdAt: number;
  parentId?: string;
};

type AnnotationExportRecord = {
  author: string;
  type: string;
  visibility: string;
  pageNumber: number;
  quotedPassage: string;
  body: string;
  createdAt: string;
  threadParentReference: string | null;
};

const CSV_COLUMNS = [
  "author",
  "type",
  "visibility",
  "page_number",
  "quoted_passage",
  "body",
  "created_at",
  "thread_parent_reference",
] as const;

function toRecord(annotation: AnnotationExportInput): AnnotationExportRecord {
  return {
    author: annotation.authorName,
    type: annotation.type,
    visibility: annotation.visibility,
    pageNumber: annotation.anchor.pageIndex + 1,
    quotedPassage: annotation.anchor.quote,
    body: annotation.body,
    createdAt: new Date(annotation.createdAt).toISOString(),
    threadParentReference: annotation.parentId ?? null,
  };
}

/** RFC 4180 field escaping, including embedded quotes and either newline style. */
function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A spreadsheet-friendly, CRLF-delimited view of exactly the supplied rows. */
export function annotationsToCsv(
  annotations: readonly AnnotationExportInput[],
): string {
  const lines = [
    CSV_COLUMNS.join(","),
    ...annotations.map((annotation) => {
      const record = toRecord(annotation);
      return [
        record.author,
        record.type,
        record.visibility,
        record.pageNumber,
        record.quotedPassage,
        record.body,
        record.createdAt,
        record.threadParentReference,
      ]
        .map(csvCell)
        .join(",");
    }),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** A stable, readable JSON projection without Convex- or UI-only fields. */
export function annotationsToJson(
  annotations: readonly AnnotationExportInput[],
): string {
  return `${JSON.stringify(annotations.map(toRecord), null, 2)}\n`;
}
