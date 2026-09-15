# AI Log Analysis

The WebUI can analyze a selected REMOTE file through an OpenAI-compatible API. Ollama, vLLM, omlx, OpenAI, and other compatible endpoints can be configured with the `[ai]` section in `src/config.ini` or with the `AI_*` environment variables.

The default request timeout is ten minutes because local CPU-based models can take several minutes to load and generate a response. The application keeps the model context window fixed at 32768 tokens. Smaller files are analyzed in one request; larger files are split by token budget while preserving line ranges and source metadata, then their structured results are summarized into a final report.

ZIP, TAR, TAR.GZ, and TGZ files are extracted into an isolated temporary directory. Archive traversal, links, file counts, per-file size, and total expansion limits are checked before text entries are analyzed. The original REMOTE archive is never modified.

Only an administrator can change the AI endpoint URL or API key. Superusers can change analysis behavior such as the model, timeout, prompt, and archive limits. API keys are masked in API responses and should preferably be supplied through the ignored `.env` file using `AI_API_KEY`.

The AI feature is disabled by default. Enable it only after confirming that the selected endpoint is reachable and that sending the selected REMOTE content to that endpoint is acceptable for the deployment.
