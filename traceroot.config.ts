import type { TraceRootConfigFile } from "traceroot-sdk-ts";

const config: TraceRootConfigFile = {
  // Basic service configuration
  service_name: "sim",
  github_owner: "simstudioai",
  github_repo_name: "sim",
  github_commit_hash: "main",

  // Your environment configuration such as development, staging, production
  environment: "production",

  // Token configuration
  // This is the token you can generate from the TraceRoot.AI website
  token: "traceroot-*",

  // Whether to enable console export of spans and logs
  enable_span_console_export: true,
  enable_log_console_export: true,

  // Local mode that whether to store all data locally
  local_mode: false,
  autoInit: true,
};
export default config;
