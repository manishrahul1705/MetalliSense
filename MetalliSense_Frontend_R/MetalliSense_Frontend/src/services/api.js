import axios from "axios";

function getCookie(name) {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
  return match ? decodeURIComponent(match[3]) : null;
}

// Cookies must use the same loopback hostname as the UI (localhost != 127.0.0.1).
const configuredBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000/api/v2";
const localBase = new URL(configuredBase, window.location.origin);
if (import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(window.location.hostname) && ['localhost', '127.0.0.1'].includes(localBase.hostname)) {
  localBase.hostname = window.location.hostname;
}
const api = axios.create({
  baseURL: localBase.href,
  timeout: parseInt(import.meta.env.VITE_API_TIMEOUT) || 30000,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

// Request interceptor: attach X-CSRF-Token on mutating requests if present in cookies
api.interceptors.request.use(
  (config) => {
    const method = (config.method || 'get').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfToken = getCookie('metallisense_csrf');
      if (csrfToken) {
        config.headers['X-CSRF-Token'] = csrfToken;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      // Handle 401 Unauthorized - redirect to login
      if (error.response.status === 401 && !error.config?.url?.startsWith("/auth/")) {
        const currentHash = window.location.hash || '';
        const currentPath = window.location.pathname || '';
        if (
          !currentHash.includes("login") &&
          !currentHash.includes("signup") &&
          !currentPath.includes("login") &&
          !currentPath.includes("signup")
        ) {
          if (import.meta.env.VITE_MOCK_MODE === "true") window.location.hash = "#/login";
          else window.location.assign("/login");
        }
      }
      console.error("API Error:", error.response.data);
    } else if (error.request) {
      console.error("Network Error:", error.message);
    }
    return Promise.reject(error);
  }
);

export default api;
