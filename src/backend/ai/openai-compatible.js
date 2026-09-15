const { DEFAULT_SYSTEM_PROMPT } = require('./prompt');

function timeoutSignal(timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AI request timed out')), timeoutMs);
  const abort = () => controller.abort(signal.reason || new Error('AI request cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

async function complete({ config, userPrompt, systemPrompt = DEFAULT_SYSTEM_PROMPT, signal, maxOutputTokens = config.maxOutputTokens }) {
  const baseUrl = String(config.baseUrl).replace(/\/$/, '');
  const timed = timeoutSignal(config.requestTimeoutMs, signal);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: timed.signal,
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
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

module.exports = { complete };
