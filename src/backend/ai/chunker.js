const fs = require('fs').promises;
const path = require('path');
const { encoding_for_model } = require('@dqbd/tiktoken');

let encoder;
function tokenCount(text) {
  encoder ||= encoding_for_model('gpt-4o');
  return encoder.encode(text).length;
}

function splitText(text, { maxTokens = 22000, overlapLines = 200 } = {}) {
  const lines = text.split(/\r?\n/);
  const lineTokenCounts = lines.map(line => tokenCount(line));
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let tokens = 0;
    while (end < lines.length) {
      const nextTokens = lineTokenCounts[end] + (end > start ? 1 : 0);
      if (tokens + nextTokens > maxTokens && end > start) break;
      tokens += nextTokens;
      end++;
      if (tokens >= maxTokens) break;
    }
    chunks.push({ text: lines.slice(start, end).join('\n'), lineStart: start + 1, lineEnd: end, tokenCount: tokens });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlapLines);
  }
  return chunks;
}

async function readTextFile(filePath, options = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw Object.assign(new Error('Only regular files can be analyzed'), { statusCode: 400 });
  if (stat.size > options.maxInputBytes) throw Object.assign(new Error(`File exceeds the ${options.maxInputBytes} byte analysis limit`), { statusCode: 413 });
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) throw Object.assign(new Error('Binary files are not supported by the text analysis pipeline'), { statusCode: 415 });
  return buffer.toString('utf8');
}

function isArchive(name) { return /\.(zip|tar|tar\.gz|tgz)$/i.test(name); }
function isTextEntry(name) { return /\.(log|txt|md|json|jsonl|csv|xml|ya?ml|ini|conf|cfg|js|ts|jsx|tsx|py|sh|c|h|cpp|rs|java|trace|out)$/i.test(name); }

module.exports = { tokenCount, splitText, readTextFile, isArchive, isTextEntry };
