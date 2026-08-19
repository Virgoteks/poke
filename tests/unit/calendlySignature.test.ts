import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { requireCalendlySignature, type RequestWithRawBody } from "../../src/api/middleware/calendlySignature.js";

const SECRET = "test-secret";

function sign(body: string, timestamp: number, secret = SECRET): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function fakeReq(headerValue: string | undefined, rawBody: string | undefined): RequestWithRawBody {
  return {
    header: (name: string) => (name.toLowerCase() === "calendly-webhook-signature" ? headerValue : undefined),
    rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody, "utf8"),
  } as unknown as RequestWithRawBody;
}

describe("requireCalendlySignature", () => {
  it("calls next() with no error for a validly signed payload", () => {
    const body = JSON.stringify({ event: "invitee.created" });
    const timestamp = Math.floor(Date.now() / 1000);
    const middleware = requireCalendlySignature(SECRET);
    const next = vi.fn();

    middleware(fakeReq(sign(body, timestamp), body), {} as never, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a request with no signature header", () => {
    const middleware = requireCalendlySignature(SECRET);
    const next = vi.fn();
    middleware(fakeReq(undefined, "{}"), {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("rejects a request signed with the wrong secret", () => {
    const body = JSON.stringify({ event: "invitee.created" });
    const timestamp = Math.floor(Date.now() / 1000);
    const middleware = requireCalendlySignature(SECRET);
    const next = vi.fn();

    middleware(fakeReq(sign(body, timestamp, "wrong-secret"), body), {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("rejects a request whose body was tampered with after signing", () => {
    const original = JSON.stringify({ event: "invitee.created" });
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(original, timestamp);
    const tampered = JSON.stringify({ event: "invitee.canceled" });
    const middleware = requireCalendlySignature(SECRET);
    const next = vi.fn();

    middleware(fakeReq(header, tampered), {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("rejects a signature whose timestamp is outside the tolerance window", () => {
    const body = JSON.stringify({ event: "invitee.created" });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 10_000;
    const middleware = requireCalendlySignature(SECRET, 300);
    const next = vi.fn();

    middleware(fakeReq(sign(body, oldTimestamp), body), {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("rejects a malformed signature header", () => {
    const middleware = requireCalendlySignature(SECRET);
    const next = vi.fn();
    middleware(fakeReq("not-a-valid-header", "{}"), {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });
});
