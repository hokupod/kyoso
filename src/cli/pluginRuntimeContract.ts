/**
 * Runtime facts captured by the disposable Codex Plugin probe.
 *
 * Keep this bundled contract structurally identical to the stable portion of
 * docs/compatibility/codex-plugin-runtime.json. The documentation record also
 * retains dated probe metadata, which deliberately does not belong in the
 * published CLI.
 */
export const PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION = 2;

export const MINIMUM_SUPPORTED_CODEX_VERSION = "0.144.0-alpha.4";

export const PLUGIN_RUNTIME_EXPECTED_CONTRACT = {
  distribution: {
    pluginVersion: "0.7.18",
    mcpCommand: "npx",
    mcpPackagePin: "@kyo-so/cli@0.16.9",
    mcpExecutable: "kyoso",
  },
  marketplace: {
    name: "kyoso",
    listed: true,
    pluginId: "kyoso@kyoso",
    selector: "kyoso@kyoso",
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
  },
  transitions: {
    beforeAdd: { installed: false, enabled: false },
    afterAdd: { installed: true, enabled: true },
    disabled: { installed: true, enabled: false },
    afterRemove: { installed: false, enabled: false },
    installPluginId: "kyoso@kyoso",
    removePluginId: "kyoso@kyoso",
  },
  mcp: {
    default: {
      enabled: true,
      command: "$NODE",
      args: ["$PROBE_SERVER", "$OBSERVATION"],
      envVars: [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_HOME",
        "CODEX_ACCESS_TOKEN",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ],
      cwd: null,
      startupTimeoutSec: 20,
      toolTimeoutSec: 2160,
    },
    pluginOverride: {
      enabled: false,
      command: "$NODE",
      args: ["$PROBE_SERVER", "$OBSERVATION"],
      envVars: [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_HOME",
        "CODEX_ACCESS_TOKEN",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ],
      cwd: null,
      startupTimeoutSec: 20,
      toolTimeoutSec: 2160,
    },
    manualOverride: {
      enabled: true,
      command: "manual-kyoso",
      args: ["mcp"],
      envVars: [],
      cwd: null,
      startupTimeoutSec: null,
      toolTimeoutSec: null,
    },
  },
  appServer: {
    default: {
      serverFound: true,
      toolNames: ["probe_environment"],
      authStatus: "unsupported",
      skillFound: false,
      skillEnabled: null,
      skillHasKyosoMcpDependency: false,
    },
    pluginOverride: {
      serverFound: true,
      toolNames: [],
      authStatus: "unsupported",
      skillFound: false,
      skillEnabled: null,
      skillHasKyosoMcpDependency: false,
      mcpObservationWritten: false,
    },
  },
  environment: {
    cwdIsWorkspace: true,
    homeInherited: true,
    codexHomeForwarded: true,
    tempDirectoryInherited: true,
    pathInherited: true,
    allowlistedEnvForwarded: {
      OPENAI_API_KEY: true,
      CODEX_API_KEY: true,
      CODEX_ACCESS_TOKEN: true,
      OPENROUTER_API_KEY: true,
      ANTHROPIC_API_KEY: true,
      CLAUDE_CODE_OAUTH_TOKEN: true,
    },
    deniedSentinelForwarded: false,
  },
  isolation: {
    distinctHomeAndCodexHome: true,
    distinctWorkspace: true,
  },
} as const;

/**
 * `codex plugin list --json` is supported only when entries have these
 * probe-observed fields. Doctor must treat all other shapes as unsupported.
 */
export const PLUGIN_LIST_JSON_SCHEMA = {
  collections: ["installed", "available"],
  entry: {
    pluginId: "kyoso@kyoso",
    requiredFields: ["pluginId", "installed", "enabled"],
  },
} as const;

/** Stable runtime contract consumed by Doctor and distribution verification. */
export const pluginRuntimeContract = {
  schemaVersion: PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION,
  minimumSupportedCodexVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
  pluginId: "kyoso@kyoso",
  pluginListTopLevelKeys: PLUGIN_LIST_JSON_SCHEMA.collections,
  expectedContract: PLUGIN_RUNTIME_EXPECTED_CONTRACT,
} as const;
