import buffer from "node:buffer";

export interface HttpResponse {
	body: unknown;
	headers?: Record<string, string | undefined>;
	ok: boolean;
	status: number;
}

export interface RequestOptions {
	body?: unknown;
	headers?: Record<string, string>;
}

export interface HttpClient {
	request(method: string, url: string, options?: RequestOptions): Promise<HttpResponse>;
}

export function createFetchClient(defaultHeaders?: Record<string, string>): HttpClient {
	return {
		async request(method, url, options) {
			const headers = {
				...defaultHeaders,
				...options?.headers,
			};

			const fetchOptions: RequestInit = {
				headers,
				method,
			};

			if (options?.body !== undefined) {
				if (options.body instanceof buffer.Buffer) {
					fetchOptions.body = options.body;
				} else {
					fetchOptions.body = JSON.stringify(options.body);
					headers["Content-Type"] = "application/json";
				}
			}

			const response = await fetch(url, fetchOptions);

			const contentType = response.headers.get("content-type");
			const body = await ((contentType?.includes("application/json") ?? false)
				? response.json()
				: response.text());

			return {
				body,
				headers: {
					"retry-after": response.headers.get("retry-after") ?? undefined,
				},
				ok: response.ok,
				status: response.status,
			};
		},
	};
}
