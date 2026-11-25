import { routes } from './routes.mjs';

function match(pattern, path) {
  const want = pattern.split('/').filter(Boolean);
  const got = path.split('/').filter(Boolean);
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return params;
}

// Finds the route for a request and calls its handler. No sockets involved.
export async function dispatch({ method, path, store, now = new Date() }) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = match(route.path, path);
    if (!params) continue;
    return route.handler({ params, store, now });
  }
  return { status: 404, body: { error: 'no such route' } };
}
