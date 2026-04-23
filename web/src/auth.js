// Shared auth helpers — password lives in localStorage after login.

export function getPassword() {
  return localStorage.getItem('maestro_password') || '';
}

export function clearPassword() {
  localStorage.removeItem('maestro_password');
}

export function apiHeaders(extra = {}) {
  const password = getPassword();
  return {
    ...extra,
    ...(password ? { 'X-Maestro-Password': password } : {}),
  };
}

export async function apiFetch(path, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...apiHeaders(options.headers),
  };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearPassword();
    window.location.reload();
  }
  return res;
}
