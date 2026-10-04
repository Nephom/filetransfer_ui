const { DEFAULT_SYSTEM_PROMPT } = require('./prompt');

function timeoutSignal(timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AI request timed out')), timeoutMs);
  const abort = () => controller.abort(signal.reason || new Error('AI request cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

async function complete({ config, userPrompt, systemPrompt = DEFAULT_SYSTEM_PROMPT, signal, maxOutputTokens = config.maxOutputTokens }) {
  const baseUrl = String(config.baseUrl).trim().replace(/\/+$/, '');
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const timed = timeoutSignal(config.requestTimeoutMs, signal);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: timed.signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.1,
        max_tokens: maxOutputTokens,
        ...(String(config.provider).toLowerCase() === 'ollama' ? { options: { num_ctx: 32768 } } : {})
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error?.message || `AI endpoint returned HTTP ${response.status}`), { statusCode: response.status });
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI endpoint returned no message content');
    return { content, model: data.model || config.model, usage: data.usage || null };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error(signal?.aborted ? 'AI analysis cancelled' : 'AI request timed out'), { code: signal?.aborted ? 'ABORT_ERR' : 'AI_TIMEOUT', statusCode: signal?.aborted ? 499 : 504 });
    throw error;
  } finally { timed.cleanup(); }
}

async function listModels({ config, signal, timeoutMs = 10_000 }) {
  const baseUrl = String(config?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw Object.assign(new Error('The AI URL must be an HTTP(S) URL'), { code: 'AI_URL_INVALID' });
  }

  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const timed = timeoutSignal(timeoutMs, signal);
  try {
    let response;
    try {
      response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        signal: timed.signal,
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        }
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timed.signal.aborted) {
        throw Object.assign(new Error('The AI model-list request timed out'), { code: 'AI_TIMEOUT' });
      }
      throw Object.assign(new Error('Unable to connect to the configured AI URL'), { code: 'AI_UNREACHABLE' });
    }

    const data = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error('The AI endpoint rejected the configured API key'), { code: 'AI_AUTH_FAILED', statusCode: response.status });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`The AI endpoint could not list models (HTTP ${response.status})`), { code: 'AI_MODEL_LIST_FAILED', statusCode: response.status });
    }

    const models = Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.models) ? data.models
        : [];
    const names = [...new Set(models.map(model => typeof model === 'string' ? model : model?.id)
      .filter(name => typeof name === 'string' && name.trim())
      .map(name => name.trim()))];
    if (!names.length) {
      throw Object.assign(new Error('The AI endpoint returned no usable models'), { code: 'AI_NO_MODELS' });
    }
    return names;
  } finally {
    timed.cleanup();
  }
}

module.exports = { complete, listModels };
