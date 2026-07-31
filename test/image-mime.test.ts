import { describe, expect, it } from "vitest";
import { isImageMediaType, resolveMediaType } from "../src/image.js";

describe("resolveMediaType", () => {
  it("uses content-type header when present", () => {
    expect(resolveMediaType({ contentTypeHeader: "image/jpeg; charset=binary", bytes: new Uint8Array([0]) })).toBe("image/jpeg");
  });

  it("detects png magic when header missing", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(resolveMediaType({ contentTypeHeader: "application/octet-stream", bytes: png })).toBe("image/png");
  });

  it("defaults to application/octet-stream", () => {
    const mime = resolveMediaType({ bytes: new Uint8Array([1, 2, 3]) });
    expect(mime).toBe("application/octet-stream");
    expect(isImageMediaType(mime)).toBe(false);
  });
});
