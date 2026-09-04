const test = require('node:test');
const assert = require('node:assert/strict');
const { clearSessionCookie, getSessionToken, setSessionCookie } = require('./session-cookie');

test('session cookie is HttpOnly and can be read from a request', () => {
  const response = { setHeader(name, value) { this.name = name; this.value = value; } };
  setSessionCookie({ secure: true, headers: {} }, response, 'token value');

  assert.equal(response.name, 'Set-Cookie');
  assert.match(response.value, /^filetransfer_session=token%20value;/);
  assert.match(response.value, /HttpOnly/);
  assert.match(response.value, /Secure/);
  assert.match(response.value, /SameSite=Lax/);

  assert.equal(getSessionToken({ headers: { cookie: response.value } }), 'token value');
});

test('session cookie is cleared without exposing a token to JavaScript', () => {
  const response = { setHeader(name, value) { this.name = name; this.value = value; } };
  clearSessionCookie({ secure: false, headers: {} }, response);

  assert.match(response.value, /^filetransfer_session=;/);
  assert.match(response.value, /Max-Age=0/);
  assert.match(response.value, /HttpOnly/);
  assert.doesNotMatch(response.value, /Secure/);
});
