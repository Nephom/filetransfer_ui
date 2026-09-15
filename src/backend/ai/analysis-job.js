const path = require('path');
const { complete } = require('./openai-compatible');
const { DEFAULT_SYSTEM_PROMPT, analysisContext, chunkPrompt, summaryPrompt } = require('./prompt');
const { readTextFile, splitText, tokenCount, isArchive } = require('./chunker');
const { extractArchive } = require('./archive-reader');

const parseJson = (content) => {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  try { return JSON.parse(match ? match[1] : content); } catch { return { summary: content, events: [], possibleCauses: [], evidence: [], uncertainties: ['Model did not return valid JSON'] }; }
};

const contextInputBudget = (config) => Math.max(
  100,
  (config.contextWindowTokens || 32768) - (config.maxOutputTokens || 8192) - 2000
);

const chunkInputBudget = (config) => Math.min(
  config.maxChunkTokens || 22000,
  contextInputBudget(config)
);

const chunkOptions = (config) => ({
  maxTokens: chunkInputBudget(config),
  overlapLines: config.chunkOverlapLines ?? 200
});

function truncateToTokens(value, maxTokens) {
  const text = String(value || '');
  if (tokenCount(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (tokenCount(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function compactItem(item, budget) {
  if (tokenCount(JSON.stringify(item)) <= budget) return { item, truncated: false };
  const analysis = item.analysis || item.summary || {};
  const base = {
    source: String(item.source || 'unknown').slice(0, 200),
    entry: item.entry ? String(item.entry).slice(0, 200) : undefined,
    chunkIndex: item.chunkIndex,
    lineStart: item.lineStart,
    lineEnd: item.lineEnd,
    truncated: true,
    analysis: { summary: '' }
  };
  let summaryBudget = Math.max(1, budget - tokenCount(JSON.stringify(base)) - 10);
  const compact = {
    ...base,
    analysis: {
      summary: truncateToTokens(analysis.summary, summaryBudget),
      events: Array.isArray(analysis.events) ? analysis.events.slice(0, 20) : [],
      possibleCauses: Array.isArray(analysis.possibleCauses) ? analysis.possibleCauses.slice(0, 20) : [],
      evidence: Array.isArray(analysis.evidence) ? analysis.evidence.slice(0, 20) : [],
      uncertainties: Array.isArray(analysis.uncertainties) ? analysis.uncertainties.slice(0, 20) : []
    }
  };
  let attempts = 0;
  while (tokenCount(JSON.stringify(compact)) > budget && attempts++ < 20) {
    if (compact.analysis.events.length) compact.analysis.events.pop();
    else if (compact.analysis.evidence.length) compact.analysis.evidence.pop();
    else if (compact.analysis.possibleCauses.length) compact.analysis.possibleCauses.pop();
    else if (compact.analysis.uncertainties.length) compact.analysis.uncertainties.pop();
    else {
      summaryBudget = Math.max(1, summaryBudget - 10);
      compact.analysis.summary = truncateToTokens(analysis.summary, summaryBudget);
      break;
    }
  }
  return { item: compact, truncated: true };
}

function groupByTokenBudget(items, budget) {
  const groups = [];
  let group = [];
  let tokens = 0;
  for (const item of items) {
    const normalized = compactItem(item, budget);
    const itemTokens = tokenCount(JSON.stringify(normalized.item));
    if (group.length && tokens + itemTokens > budget) {
      groups.push(group);
      group = [];
      tokens = 0;
    }
    group.push(normalized.item);
    tokens += itemTokens;
  }
  if (group.length) groups.push(group);
  return groups;
}

async function summarizeGroup(items, config, signal, level) {
  const response = await complete({
    config,
    signal,
    systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    userPrompt: summaryPrompt(items.map(item => JSON.stringify(item)).join('\n')),
    maxOutputTokens: config.maxOutputTokens
  });
  return {
    level,
    summary: parseJson(response.content),
    model: response.model,
    sourceCount: items.length
  };
}

async function summarizeResults(results, config, signal, onProgress) {
  const leaves = results.flatMap(item => item.chunks || []).map(chunk => ({
    source: chunk.source,
    entry: chunk.entry,
    chunkIndex: chunk.chunkIndex,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    analysis: chunk
  }));
  let nodes = leaves;
  let level = 1;
  const budget = contextInputBudget(config);
  let incomplete = leaves.some(item => compactItem(item, budget).truncated);
  while (nodes.length > 1 || tokenCount(JSON.stringify(nodes[0] || {})) > budget) {
    const groups = groupByTokenBudget(nodes, budget);
    if (groups.length === 1 && nodes.length === 1) {
      nodes = [compactItem(nodes[0], budget).item];
      incomplete = true;
      break;
    }
    const next = [];
    for (let index = 0; index < groups.length; index++) {
      if (signal?.aborted) throw Object.assign(new Error('AI analysis cancelled'), { code: 'ABORT_ERR', statusCode: 499 });
      next.push(await summarizeGroup(groups[index], config, signal, level));
      onProgress?.({ phase: 'aggregate', completed: index + 1, total: groups.length, level });
    }
    nodes = next;
    level++;
  }
  return { nodes, leafCount: leaves.length, aggregationLevels: level - 1, incomplete };
}

async function analyzeText({ filePath, source, entry, config, signal, onProgress }) {
  const text = await readTextFile(filePath, { maxInputBytes: config.maxInputBytes });
  const chunks = splitText(text, chunkOptions(config));
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
  const startedAt = Date.now();
  let extractedAt = startedAt;
  try {
    if (isArchive(source)) {
      onProgress?.({ phase: 'scan', completed: 0, total: 1, source });
      const archive = await extractArchive(filePath, config);
      cleanup = archive.cleanup;
      extractedAt = Date.now();
      onProgress?.({ phase: 'scan', completed: archive.entries.length, total: archive.entries.length, source });
      for (const entry of archive.entries) {
        results.push(await analyzeText({ filePath: entry.path, source, entry: entry.name, config, signal, onProgress }));
      }
    } else {
      results.push(await analyzeText({ filePath, source, config, signal, onProgress }));
    }
    onProgress?.({ phase: 'summary', completed: 0, total: 1, source });
    const aggregation = await summarizeResults(results, config, signal, onProgress);
    const final = await complete({
      config,
      signal,
      systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      userPrompt: summaryPrompt(JSON.stringify(aggregation.nodes[0] || {})),
      maxOutputTokens: config.maxOutputTokens
    });
    onProgress?.({ phase: 'summary', completed: 1, total: 1, source });
    return {
      result: final.content,
      model: final.model,
      sources: results,
      incomplete: aggregation.incomplete,
      coverage: {
        analyzedEntries: results.length,
        analyzedChunks: aggregation.leafCount,
        aggregationLevels: aggregation.aggregationLevels,
        contextInputBudget: contextInputBudget(config),
        extractionMs: extractedAt - startedAt,
        totalMs: Date.now() - startedAt,
        incomplete: aggregation.incomplete
      }
    };
  } finally { await cleanup?.(); }
}

module.exports = { analyzePath, parseJson, chunkOptions, contextInputBudget, groupByTokenBudget };
