# AI Log Analysis

The WebUI can analyze a selected REMOTE file through an OpenAI-compatible API. Ollama, vLLM, omlx, OpenAI, and other compatible endpoints can be configured with the `[ai]` section in `src/config.ini` or with the `AI_*` environment variables.

The administrator username and password are deployment credentials and must be configured in `.env` with `AUTH_USERNAME`, `AUTH_PASSWORD`, and `AUTH_PASSWORD_HASHED`. They are not stored in `src/config.ini`. After signing in, the administrator can use the password-change action; the new bcrypt hash is written back to `.env`.

AI requests include the selected Location ID and revision. A stale revision is rejected with a refresh response instead of being treated as an AI provider failure.

The default request timeout is two hours because local CPU-based models can take several minutes to load and generate a response. The application keeps the model context window fixed at 32768 tokens. Each request reserves space for the system prompt and model output, so the configured chunk size is capped by the actual available input budget. Smaller files are analyzed in one request; larger files are split by token budget while preserving line ranges and source metadata.

Chunk results are not concatenated into an unbounded final request. Large analyses use bounded, hierarchical aggregation: chunk results are grouped under the input budget, each group is summarized, and higher levels are created until a bounded final report can be generated. The result includes entry/chunk counts, aggregation levels, extraction time, total analysis time, and an incomplete flag. A model response is not treated as proof that every source chunk was included.

ZIP, TAR, TAR.GZ, and TGZ files are extracted into an isolated temporary directory. Archive traversal, links, file counts, per-file size, and total expansion limits are checked before text entries are analyzed. The original REMOTE archive is never modified. Archive entries are analyzed in order and are included in the coverage statistics; extraction and total analysis duration are reported separately.

Only an administrator can change the AI endpoint URL or API key. Superusers can change analysis behavior such as the model, timeout, prompt, and archive limits. API keys are masked in API responses and should preferably be supplied through the ignored `.env` file using `AI_API_KEY`.

The AI feature is disabled by default. Enable it only after confirming that the selected endpoint is reachable and that sending the selected REMOTE content to that endpoint is acceptable for the deployment.
