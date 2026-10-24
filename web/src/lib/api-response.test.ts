import { describe, expect, it } from "vitest";
import { checkApiRequest } from "./api-response";

describe("API query validation", () => {
  it("accepts a valid checksummed address", async () => {
    const request = new Request(
      "https://example.test/api/health?address=0x3F68BC087AeB7F46b956F7F85Cd342B1274bF765",
      { headers: { "x-real-ip": "192.0.2.20" } },
    );
    const checked = await checkApiRequest(request);
    expect("address" in checked).toBe(true);
  });

  it("accepts a lowercase address", async () => {
    const checked = await checkApiRequest(
      new Request(
        "https://example.test/api/health?address=0x3f68bc087aeb7f46b956f7f85cd342b1274bf765",
        { headers: { "x-real-ip": "192.0.2.23" } },
      ),
    );
    expect("address" in checked).toBe(true);
  });

  it("rejects malformed addresses, duplicate parameters, and unknown parameters", async () => {
    const invalidRequests = [
      "https://example.test/api/health?address=not-an-address",
      "https://example.test/api/health?address=0x3F68BC087AeB7F46b956F7F85Cd342B1274bF765&extra=1",
      "https://example.test/api/health?address=0x3F68BC087AeB7F46b956F7F85Cd342B1274bF765&address=0x3F68BC087AeB7F46b956F7F85Cd342B1274bF765",
    ];
    for (const url of invalidRequests) {
      const checked = await checkApiRequest(
        new Request(url, { headers: { "x-real-ip": "192.0.2.21" } }),
      );
      expect("response" in checked).toBe(true);
      if ("response" in checked) {
        expect(checked.response.status).toBe(400);
        expect(checked.response.headers.get("cache-control")).toBe("no-store");
      }
    }
  });

  it("rejects an overlong request URL", async () => {
    const checked = await checkApiRequest(
      new Request(`https://example.test/api/health?address=${"a".repeat(2100)}`, {
        headers: { "x-real-ip": "192.0.2.22" },
      }),
    );
    expect("response" in checked).toBe(true);
    if ("response" in checked) expect(checked.response.status).toBe(414);
  });
});
