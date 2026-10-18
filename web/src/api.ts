export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export const getToken = () => localStorage.getItem("token");

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any; headers?: Record<string, string> } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api" + path, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) {
      localStorage.removeItem("token");
      location.reload();
    }
    throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? res.statusText, data?.error?.details);
  }
  return data as T;
}
