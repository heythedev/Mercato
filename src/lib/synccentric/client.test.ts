import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { synccentricConfigured, synccentricPrimary } from "./client";

const saved = {
  token: process.env.SYNCCENTRIC_API_TOKEN,
  primary: process.env.SYNCCENTRIC_PRIMARY,
};

beforeEach(() => {
  delete process.env.SYNCCENTRIC_API_TOKEN;
  delete process.env.SYNCCENTRIC_PRIMARY;
});

afterAll(() => {
  if (saved.token != null) process.env.SYNCCENTRIC_API_TOKEN = saved.token;
  else delete process.env.SYNCCENTRIC_API_TOKEN;
  if (saved.primary != null) process.env.SYNCCENTRIC_PRIMARY = saved.primary;
  else delete process.env.SYNCCENTRIC_PRIMARY;
});

describe("synccentricPrimary", () => {
  it("defaults to primary whenever a token is configured", () => {
    process.env.SYNCCENTRIC_API_TOKEN = "tok";
    expect(synccentricPrimary()).toBe(true);
  });

  it("is never primary without a token", () => {
    expect(synccentricConfigured()).toBe(false);
    expect(synccentricPrimary()).toBe(false);
    process.env.SYNCCENTRIC_PRIMARY = "1";
    expect(synccentricPrimary()).toBe(false);
  });

  it("can be flipped back to Keepa-led with an explicit opt-out", () => {
    process.env.SYNCCENTRIC_API_TOKEN = "tok";
    for (const v of ["0", "false", "no", "off", "OFF"]) {
      process.env.SYNCCENTRIC_PRIMARY = v;
      expect(synccentricPrimary()).toBe(false);
    }
  });

  it("stays primary for affirmative or unrecognized values", () => {
    process.env.SYNCCENTRIC_API_TOKEN = "tok";
    for (const v of ["1", "true", "yes", "on"]) {
      process.env.SYNCCENTRIC_PRIMARY = v;
      expect(synccentricPrimary()).toBe(true);
    }
  });

  it("tolerates a token pasted with surrounding quotes", () => {
    process.env.SYNCCENTRIC_API_TOKEN = '"tok"';
    expect(synccentricConfigured()).toBe(true);
  });
});
