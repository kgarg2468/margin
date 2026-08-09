import {
  cleanReferenceText,
  parseBibTeXAuthors,
  readYear,
} from "./normalize";
import type { ReferenceEntry } from "./types";

const DIRECTIVES = new Set(["comment", "preamble", "string"]);

/** Parse bibliography entries without interpreting unrelated BibTeX directives. */
export function parseBibTeX(input: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const at = input.indexOf("@", cursor);
    if (at === -1) {
      break;
    }

    const header = /^@\s*([a-z][\w-]*)\s*([{(])/i.exec(input.slice(at));
    if (header === null) {
      cursor = at + 1;
      continue;
    }

    const type = (header[1] ?? "").toLowerCase();
    const opener = header[2];
    if (opener !== "{" && opener !== "(") {
      cursor = at + header[0].length;
      continue;
    }

    const bodyStart = at + header[0].length;
    const balanced = readEntryBody(input, bodyStart, opener);
    cursor = balanced === null ? bodyStart : balanced.end;
    if (balanced === null || DIRECTIVES.has(type)) {
      continue;
    }

    const firstComma = findTopLevelComma(balanced.body);
    if (firstComma === -1) {
      continue;
    }
    const fields = readFields(balanced.body.slice(firstComma + 1));
    const title = cleanReferenceText(fields.get("title") ?? "");
    if (title.length === 0) {
      continue;
    }

    const venue = cleanOptional(
      fields.get("journal") ?? fields.get("booktitle"),
    );
    const doi = cleanOptional(fields.get("doi"));
    const abstract = cleanOptional(fields.get("abstract"));
    const url = cleanOptional(fields.get("url"));
    entries.push({
      title,
      authors: parseBibTeXAuthors(fields.get("author") ?? ""),
      year: readYear(fields.get("year")),
      venue,
      doi,
      abstract,
      url,
    });
  }

  return entries;
}

function cleanOptional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cleaned = cleanReferenceText(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

function readEntryBody(
  input: string,
  start: number,
  opener: "{" | "(",
): { body: string; end: number } | null {
  let braceDepth = opener === "{" ? 1 : 0;
  let parenDepth = opener === "(" ? 1 : 0;
  let quoted = false;

  for (let index = start; index < input.length; index++) {
    const character = input[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }

    if (character === "{") {
      braceDepth++;
    } else if (character === "}") {
      braceDepth--;
      if (opener === "{" && braceDepth === 0) {
        return { body: input.slice(start, index), end: index + 1 };
      }
    } else if (braceDepth === 0 && character === "(") {
      parenDepth++;
    } else if (braceDepth === 0 && character === ")") {
      parenDepth--;
      if (opener === "(" && parenDepth === 0) {
        return { body: input.slice(start, index), end: index + 1 };
      }
    }
  }
  return null;
}

function findTopLevelComma(value: string): number {
  let braceDepth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") {
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "{") {
      braceDepth++;
    } else if (!quoted && character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (!quoted && braceDepth === 0 && character === ",") {
      return index;
    }
  }
  return -1;
}

function readFields(value: string): Map<string, string> {
  const fields = new Map<string, string>();
  let cursor = 0;

  while (cursor < value.length) {
    while (/[,\s]/.test(value[cursor] ?? "")) {
      cursor++;
    }
    const name = /^[a-z][\w-]*/i.exec(value.slice(cursor));
    if (name === null) {
      const comma = value.indexOf(",", cursor);
      cursor = comma === -1 ? value.length : comma + 1;
      continue;
    }
    cursor += name[0].length;
    while (/\s/.test(value[cursor] ?? "")) {
      cursor++;
    }
    if (value[cursor] !== "=") {
      continue;
    }
    cursor++;
    while (/\s/.test(value[cursor] ?? "")) {
      cursor++;
    }

    const parsed = readFieldValue(value, cursor);
    fields.set(name[0].toLowerCase(), parsed.value);
    cursor = parsed.end;
  }
  return fields;
}

function readFieldValue(
  value: string,
  start: number,
): { value: string; end: number } {
  if (value[start] === "{") {
    let depth = 1;
    for (let index = start + 1; index < value.length; index++) {
      if (value[index] === "\\") {
        index++;
      } else if (value[index] === "{") {
        depth++;
      } else if (value[index] === "}") {
        depth--;
        if (depth === 0) {
          return { value: value.slice(start + 1, index), end: index + 1 };
        }
      }
    }
    return { value: value.slice(start + 1), end: value.length };
  }

  if (value[start] === '"') {
    for (let index = start + 1; index < value.length; index++) {
      if (value[index] === "\\") {
        index++;
      } else if (value[index] === '"') {
        return { value: value.slice(start + 1, index), end: index + 1 };
      }
    }
    return { value: value.slice(start + 1), end: value.length };
  }

  const comma = value.indexOf(",", start);
  const end = comma === -1 ? value.length : comma;
  return { value: value.slice(start, end).trim(), end };
}
