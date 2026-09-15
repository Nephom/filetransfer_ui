const path = require('path');
const { complete } = require('./openai-compatible');
const { DEFAULT_SYSTEM_PROMPT, analysisContext, chunkPrompt, summaryPrompt } = require('./prompt');
const { readTextFile, splitText, isArchive } = require('./chunker');
const { extractArchive } = require('./archive-reader');

const parseJson = (content) => {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  try { return JSON.parse(match ? match[1] : content); } catch { return { summary: content, events: [], possibleCauses: [], evidence: [], uncertainties: ['Model did not return valid JSON'] }; }
};

async function analyzeText({ filePath, source, entry, config, signal, onProgress }) {
  const text = await readTextFile(filePath, { maxInputBytes: config.maxInputBytes });
  const chunks = splitText(text, config);
  const completeFile = chunks.length === 1;
  const summaries = [];
  for (let index = 0; index < chunks.length; index++) {
    if (signal?.aborted) throw Object.assign(new Error('AI analysis cancelled'), { code: 'ABORT_ERR', statusCode: 499 });
    const chunk = chunks[index];
    onProgress?.({ phase: 'analyze', completed: index, total: chunks.length, source, entry });
    let result;
    let lastError;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const response = await complete({
          config,
          signal,
          systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
          userPrompt: `${chunkPrompt(analysisContext({ source, entry, complete: completeFile, chunkIndex: index, chunkCount: chunks.length, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd }))}\n\n<log>\n${chunk.text}\n</log>`
        });
        result = { ...parseJson(response.content), model: response.model, chunkIndex: index, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, source, entry };
        break;
      } catch (error) { lastError = error; if (attempt >= config.maxRetries) throw error; }
    }
    summaries.push(result || { error: lastError?.message, chunkIndex: index, source, entry });
    onProgress?.({ phase: 'analyze', completed: index + 1, total: chunks.length, source, entry });
  }
  return { source, entry, chunks: summaries, complete: true };
}

async function analyzePath({ filePath, source = path.basename(filePath), config, signal, onProgress }) {
  const results = [];
  let cleanup = null;
  try {
    if (isArchive(source)) {
      onProgress?.({ phase: 'scan', completed: 0, total: 1, source });
      const archive = await extractArchive(filePath, config);
      cleanup = archive.cleanup;
      onProgress?.({ phase: 'scan', completed: archive.entries.length, total: archive.entries.length, source });
      for (const entry of archive.entries) {
        results.push(await analyzeText({ filePath: entry.path, source, entry: entry.name, config, signal, onProgress }));
      }
    } else {
      results.push(await analyzeText({ filePath, source, config, signal, onProgress }));
    }
    onProgress?.({ phase: 'summary', completed: 0, total: 1, source });
    const flattened = results.flatMap(item => item.chunks || []).map(item => JSON.stringify(item)).join('\n');
    const final = await complete({ config, signal, systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT, userPrompt: summaryPrompt(flattened) });
    onProgress?.({ phase: 'summary', completed: 1, total: 1, source });
    return { result: final.content, model: final.model, sources: results, incomplete: false };
  } finally { await cleanup?.(); }
}

module.exports = { analyzePath, parseJson };
