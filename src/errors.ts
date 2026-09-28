export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const badRequest = (msg: string) => new ApiError("BAD_REQUEST", msg, 400);
export const notFound = (msg: string) => new ApiError("NOT_FOUND", msg, 404);
export const conflict = (msg: string) => new ApiError("CONFLICT", msg, 409);
export const unprocessable = (msg: string) => new ApiError("UNPROCESSABLE", msg, 422);
