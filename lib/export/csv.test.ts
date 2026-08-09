import { describe, expect, it } from "vitest";
import {
  annotationsToCsv,
  annotationsToJson,
  type AnnotationExportInput,
} from "./csv";

const annotations: AnnotationExportInput[] = [
  {
    authorName: "Ada Lovelace",
    type: "method",
    visibility: "lab",
    anchor: { pageIndex: 1, quote: 'A passage with "quotes", and a comma' },
    body: "First line\nSecond line",
    createdAt: Date.UTC(2026, 7, 8, 16, 30),
  },
  {
    authorName: "Grace Hopper",
    type: "open-question",
    visibility: "private",
    anchor: { pageIndex: 0, quote: "Why does this work?" },
    body: "Needs another experiment.",
    createdAt: Date.UTC(2026, 7, 8, 17, 45),
    parentId: "annotation-parent-1",
  },
];

describe("annotationsToCsv", () => {
  it("exports the documented columns and converts zero-based page indexes", () => {
    expect(annotationsToCsv(annotations)).toBe(
      "author,type,visibility,page_number,quoted_passage,body,created_at,thread_parent_reference\r\n" +
        'Ada Lovelace,method,lab,2,"A passage with ""quotes"", and a comma","First line\nSecond line",2026-08-08T16:30:00.000Z,\r\n' +
        "Grace Hopper,open-question,private,1,Why does this work?,Needs another experiment.,2026-08-08T17:45:00.000Z,annotation-parent-1\r\n",
    );
  });

  it("still produces a useful header when the paper has no annotations", () => {
    expect(annotationsToCsv([])).toBe(
      "author,type,visibility,page_number,quoted_passage,body,created_at,thread_parent_reference\r\n",
    );
  });
});

describe("annotationsToJson", () => {
  it("exports only the promised fields with ISO timestamps and nullable parents", () => {
    expect(annotationsToJson(annotations)).toBe(
      JSON.stringify(
        [
          {
            author: "Ada Lovelace",
            type: "method",
            visibility: "lab",
            pageNumber: 2,
            quotedPassage: 'A passage with "quotes", and a comma',
            body: "First line\nSecond line",
            createdAt: "2026-08-08T16:30:00.000Z",
            threadParentReference: null,
          },
          {
            author: "Grace Hopper",
            type: "open-question",
            visibility: "private",
            pageNumber: 1,
            quotedPassage: "Why does this work?",
            body: "Needs another experiment.",
            createdAt: "2026-08-08T17:45:00.000Z",
            threadParentReference: "annotation-parent-1",
          },
        ],
        null,
        2,
      ) + "\n",
    );
  });
});
