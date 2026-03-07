/**
 * api.js — Wesbell Dispatch API client
 */

export const CSRF = { 'X-Requested-With': 'XMLHttpRequest' };

/**
 * apiJson(url, opts?) → Promise<any>
 * Thin wrapper around fetch that:
 *  - Sets X-Requested-With automatically
 *  - Throws on non-2xx with the response text as message
 */
export async function apiJson(url, opts = {}) {
  const headers = {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...CSRF,
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(text), { status: res.status });
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/**
 * apiPost(url, data) → Promise<any>
 * Shorthand for JSON POST.
 */
export function apiPost(url, data) {
  return apiJson(url, { method: 'POST', body: JSON.stringify(data) });
}
