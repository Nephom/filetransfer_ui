const SESSION_COOKIE = 'filetransfer_session';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isSecureRequest = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

const setSessionCookie = (req, res, token) => {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE_MS / 1000}; HttpOnly; Path=/; SameSite=Lax${secure}`);
};

const clearSessionCookie = (req, res) => {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; Path=/; SameSite=Lax${secure}`);
};

const getSessionToken = (req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1));
  } catch {
    return null;
  }
};

module.exports = { clearSessionCookie, getSessionToken, setSessionCookie };
