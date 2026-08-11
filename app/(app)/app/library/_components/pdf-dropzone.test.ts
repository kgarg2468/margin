import { describe, expect, it } from "vitest";
import { offerFile } from "./pdf-dropzone";

/**
 * The browser pass found the disabled dropzone taking a real drag-and-drop: the
 * prop dimmed the zone and stopped the click, and the drop path never asked
 * about it. Two attaches ran into one progress bar, two files landed on one
 * paper, and the single cancel could only reach one of the two runs.
 *
 * Nothing here renders — the drop itself belongs to the browser pass. What is
 * pinned is the decision the handlers now delegate to, which is where the
 * refusal either holds for both entrances or holds for neither.
 */

function pdf(name = "paper.pdf"): File {
  return new File(["%PDF-1.7"], name, { type: "application/pdf" });
}

describe("offerFile", () => {
  it("ignores a dropped PDF while the zone is busy", () => {
    expect(offerFile(pdf(), true)).toEqual({ kind: "ignored" });
  });

  it("ignores it whatever the file is, rather than calling it the wrong type", () => {
    // A refusal that came back as `rejected` would put "that isn't a PDF" under
    // a zone whose actual answer is "not now".
    const notPdf = new File(["notes"], "notes.txt", { type: "text/plain" });
    expect(offerFile(notPdf, true)).toEqual({ kind: "ignored" });
  });

  it("accepts a PDF and carries it, so the caller cannot lose it", () => {
    const file = pdf();
    expect(offerFile(file, false)).toEqual({ kind: "accepted", file });
  });

  it("takes the extension when the drag brings no type", () => {
    const file = new File(["%PDF-1.7"], "scan.PDF", { type: "" });
    expect(offerFile(file, false)).toEqual({ kind: "accepted", file });
  });

  it("rejects a file that is not a PDF", () => {
    const notPdf = new File(["notes"], "notes.txt", { type: "text/plain" });
    expect(offerFile(notPdf, false)).toEqual({ kind: "rejected" });
  });

  it("ignores an empty drag rather than rejecting it", () => {
    // A drag of selected text lands here with no file at all, and it has done
    // nothing wrong.
    expect(offerFile(undefined, false)).toEqual({ kind: "ignored" });
  });
});
