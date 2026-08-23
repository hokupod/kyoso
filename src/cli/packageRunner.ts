export const KYOSO_PACKAGE_NAME = "@kyo-so/cli";
export const KYOSO_PACKAGE_ALIAS = "kyoso-cli";
/** Prefix of an aliased specifier, so callers never rebuild `@npm:` themselves. */
export const KYOSO_PACKAGE_ALIAS_PREFIX = `${KYOSO_PACKAGE_ALIAS}@npm:`;
export const KYOSO_EXECUTABLE_NAME = "kyoso";

export type KyosoPackageRunner = "npx" | "bunx";

export type KyosoPackageCommand = {
  command: KyosoPackageRunner;
  args: string[];
};

export type BuildKyosoPackageCommandOptions = {
  runner: KyosoPackageRunner;
  cliArgs: readonly string[];
  version?: string;
};

const COMPLETE_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function buildKyosoPackageCommand(
  options: BuildKyosoPackageCommandOptions,
): KyosoPackageCommand {
  const packageSpec =
    options.version === undefined
      ? KYOSO_PACKAGE_NAME
      : `${KYOSO_PACKAGE_NAME}@${assertCompleteSemVer(options.version)}`;
  // The alias installs the package under a name no Kyoso checkout carries, so a
  // package runner launched from one cannot resolve that workspace instead of
  // the published package.
  const aliasedPackageSpec = `${KYOSO_PACKAGE_ALIAS_PREFIX}${packageSpec}`;
  const cliArgs = [...options.cliArgs];

  if (options.runner === "npx") {
    return {
      command: "npx",
      args: [
        "-y",
        `--package=${aliasedPackageSpec}`,
        KYOSO_EXECUTABLE_NAME,
        ...cliArgs,
      ],
    };
  }

  return {
    command: "bunx",
    args: ["--package", aliasedPackageSpec, KYOSO_EXECUTABLE_NAME, ...cliArgs],
  };
}

export function formatKyosoPackageCommand(
  options: BuildKyosoPackageCommandOptions,
): string {
  const command = buildKyosoPackageCommand(options);
  return [command.command, ...command.args].join(" ");
}

export function isCompleteSemVer(value: string): boolean {
  const match = COMPLETE_SEMVER.exec(value);
  const prerelease = match?.[4];
  return (
    match !== null &&
    (prerelease === undefined ||
      prerelease.split(".").every((identifier) => {
        return (
          !/^\d+$/.test(identifier) ||
          identifier === "0" ||
          !identifier.startsWith("0")
        );
      }))
  );
}

function assertCompleteSemVer(value: string): string {
  if (isCompleteSemVer(value)) return value;
  throw new Error(
    `Kyoso package version must be a complete SemVer; received ${JSON.stringify(value)}.`,
  );
}
