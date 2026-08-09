import {
  cleanReferenceText,
  normalizeAuthor,
  readYear,
} from "./normalize";
import type { ReferenceEntry } from "./types";

type RisRecord = Map<string, string[]>;

/** Parse standard tagged RIS records, retaining continuation lines. */
export function parseRis(input: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  let record: RisRecord = new Map();
  let lastTag: string | null = null;

  function finishRecord() {
    const entry = toEntry(record);
    if (entry !== null) {
      entries.push(entry);
    }
    record = new Map();
    lastTag = null;
  }

  for (const line of input.replace(/\r\n?/g, "\n").split("\n")) {
    const tagged = /^([A-Z0-9]{2})\s*-\s?(.*)$/.exec(line);
    if (tagged === null) {
      const continuation = line.trim();
      if (lastTag !== null && continuation.length > 0) {
        const values = record.get(lastTag);
        const lastIndex = (values?.length ?? 0) - 1;
        if (values !== undefined && lastIndex >= 0) {
          values[lastIndex] = `${values[lastIndex]} ${continuation}`;
        }
      }
      continue;
    }

    const tag = tagged[1] ?? "";
    const contents = tagged[2] ?? "";
    if (tag === "TY" && record.size > 0) {
      finishRecord();
    }
    if (tag === "ER") {
      finishRecord();
      continue;
    }
    const values = record.get(tag) ?? [];
    values.push(contents);
    record.set(tag, values);
    lastTag = tag;
  }

  if (record.size > 0) {
    finishRecord();
  }
  return entries;
}

function toEntry(record: RisRecord): ReferenceEntry | null {
  const first = (...tags: string[]): string | undefined => {
    for (const tag of tags) {
      const value = record.get(tag)?.[0];
      if (value !== undefined && value.trim().length > 0) {
        return value;
      }
    }
    return undefined;
  };

  const title = cleanReferenceText(first("TI", "T1") ?? "");
  if (title.length === 0) {
    return null;
  }
  const authorValues = record.get("AU") ?? record.get("A1") ?? [];

  return {
    title,
    authors: authorValues.map(normalizeAuthor).filter(Boolean),
    year: readYear(first("PY", "Y1")),
    venue: cleanOptional(first("JO", "JF", "T2")),
    doi: cleanOptional(first("DO")),
    abstract: cleanOptional(first("AB")),
    url: cleanOptional(first("UR")),
  };
}

function cleanOptional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cleaned = cleanReferenceText(value);
  return cleaned.length > 0 ? cleaned : undefined;
}
