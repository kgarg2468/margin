import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadText, exportFilename } from "./download";

describe("exportFilename", () => {
  it("keeps a readable paper title while removing filename control characters", () => {
    expect(exportFilename('  Paper: "Trust / Exit?"  ', "md")).toBe(
      "Paper- -Trust - Exit--.md",
    );
  });

  it("uses a safe fallback for an unusable title", () => {
    expect(exportFilename("  ...  ", ".bib")).toBe("export.bib");
  });
});

describe("downloadText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads a Blob with the requested filename and media type", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = { href: "", download: "", click, remove };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:margin-export");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    downloadText("hello, margin", "notes.csv", "text/csv;charset=utf-8");

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) {
      throw new Error("Expected downloadText to create a Blob");
    }
    expect(blob.type).toBe("text/csv;charset=utf-8");
    await expect(blob.text()).resolves.toBe("hello, margin");
    expect(anchor).toMatchObject({
      href: "blob:margin-export",
      download: "notes.csv",
    });
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:margin-export");
  });
});
