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
    deleted: false,
  },
  {
    authorName: "Grace Hopper",
    type: "open-question",
    visibility: "private",
    anchor: { pageIndex: 0, quote: "Why does this work?" },
    body: "Needs another experiment.",
    createdAt: Date.UTC(2026, 7, 8, 17, 45),
    parentId: "annotation-parent-1",
    deleted: false,
  },
];

describe("annotationsToCsv", () => {
  it("exports the documented columns and converts zero-based page indexes", () => {
    expect(annotationsToCsv(annotations)).toBe(
      "author,type,visibility,page_number,quoted_passage,body,created_at,thread_parent_reference,deleted\r\n" +
        'Ada Lovelace,method,lab,2,"A passage with ""quotes"", and a comma","First line\nSecond line",2026-08-08T16:30:00.000Z,,false\r\n' +
        "Grace Hopper,open-question,private,1,Why does this work?,Needs another experiment.,2026-08-08T17:45:00.000Z,annotation-parent-1,false\r\n",
    );
  });

  it("neutralizes formula-capable text cells without changing numeric cells", () => {
    const dangerous: AnnotationExportInput[] = [
      {
        authorName: "=author",
        type: "method",
        visibility: "lab",
        anchor: { pageIndex: 0, quote: "+quote" },
        body: "-body",
        createdAt: Date.UTC(2026, 7, 8, 16, 30),
        deleted: false,
      },
      {
        authorName: "@author",
        type: "method",
        visibility: "lab",
        anchor: { pageIndex: -2, quote: "\t=quote" },
        body: "\r+body",
        createdAt: Date.UTC(2026, 7, 8, 16, 30),
        deleted: false,
      },
    ];

    expect(annotationsToCsv(dangerous)).toBe(
      "author,type,visibility,page_number,quoted_passage,body,created_at,thread_parent_reference,deleted\r\n" +
        "'=author,method,lab,1,'+quote,'-body,2026-08-08T16:30:00.000Z,,false\r\n" +
        "'@author,method,lab,-1,'\t=quote,\"'\r+body\",2026-08-08T16:30:00.000Z,,false\r\n",
    );
  });

  it("marks withdrawn annotations while preserving their empty content", () => {
    const withdrawn: AnnotationExportInput = {
      authorName: "Ada Lovelace",
      type: "method",
      visibility: "lab",
      anchor: { pageIndex: 0, quote: "" },
      body: "",
      createdAt: Date.UTC(2026, 7, 8, 16, 30),
      deleted: true,
    };

    expect(annotationsToCsv([withdrawn])).toBe(
      "author,type,visibility,page_number,quoted_passage,body,created_at,thread_parent_reference,deleted\r\n" +
        "Ada Lovelace,method,lab,1,,,2026-08-08T16:30:00.000Z,,true\r\n",
    );
  });

  it("still produces a useful header when the paper has no annotations", () => {
    expect(annotationsToCsv([])).toBe(
      "author,type,visibility,page_number,quoted_passage,body,created_at,thread_parent_reference,deleted\r\n",
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
            deleted: false,
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
            deleted: false,
          },
        ],
        null,
        2,
      ) + "\n",
    );
  });

  it("marks withdrawn annotations while preserving their empty content", () => {
    const withdrawn: AnnotationExportInput = {
      authorName: "Grace Hopper",
      type: "open-question",
      visibility: "private",
      anchor: { pageIndex: 0, quote: "" },
      body: "",
      createdAt: Date.UTC(2026, 7, 8, 17, 45),
      deleted: true,
    };

    expect(JSON.parse(annotationsToJson([withdrawn]))).toEqual([
      {
        author: "Grace Hopper",
        type: "open-question",
        visibility: "private",
        pageNumber: 1,
        quotedPassage: "",
        body: "",
        createdAt: "2026-08-08T17:45:00.000Z",
        threadParentReference: null,
        deleted: true,
      },
    ]);
  });
});
