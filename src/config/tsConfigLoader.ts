import { createRequire } from "node:module";
import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { defineConfig as localDefineConfig } from "./defineConfig.js";

type ConfigModule = {
  default?: unknown;
  config?: unknown;
  [key: string]: unknown;
};

export async function loadConfigModule(filePath: string, source: string): Promise<ConfigModule> {
  const ext = extname(filePath);
  if (ext === ".ts" || ext === ".tsx") {
    return loadTypeScriptConfig(filePath, source);
  }
  return (await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`)) as ConfigModule;
}

function loadTypeScriptConfig(filePath: string, source: string): ConfigModule {
  const sourceWithoutSelfImport = source.replace(
    /^\s*import\s+\{[^}]*defineConfig[^}]*\}\s+from\s+["']@kyoso\/cli["'];?\s*$/gm,
    "",
  );
  const transpiled = ts.transpileModule(sourceWithoutSelfImport, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    fileName: filePath,
  }).outputText;

  const module = { exports: {} as ConfigModule };
  const require = createRequire(pathToFileURL(filePath));
  const script = new vm.Script(
    `(function(exports, require, module, __filename, __dirname, defineConfig) {\n${transpiled}\n})`,
    { filename: filePath },
  );
  const runner = script.runInThisContext() as (
    exports: ConfigModule,
    require: NodeJS.Require,
    module: { exports: ConfigModule },
    filename: string,
    dirname: string,
    defineConfig: typeof localDefineConfig,
  ) => void;
  runner(module.exports, require, module, filePath, dirname(filePath), localDefineConfig);
  return module.exports;
}
