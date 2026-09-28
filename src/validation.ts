import { ApiError } from "./types.js";

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, "VALIDATION_ERROR", `${field} is required`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiError(400, "VALIDATION_ERROR", "expected string");
  return value;
}

export function integer(value: unknown, field: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const normalized = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof normalized !== "number" || !Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

export function positiveId(value: unknown, field: string): number {
  return integer(value, field, 1);
}

export function pageParams(url: URL): { limit: number; offset: number } {
  const limit = integer(url.searchParams.get("limit") ?? "50", "limit", 1, 200);
  const offset = integer(url.searchParams.get("offset") ?? "0", "offset", 0);
  return { limit, offset };
}

export function assert(condition: unknown, code: string, message: string, status = 409): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
