export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") =>
  new HttpError(404, "NOT_FOUND", `${what} not found`);
export const forbidden = (message = "You are not allowed to do this") =>
  new HttpError(403, "FORBIDDEN", message);
