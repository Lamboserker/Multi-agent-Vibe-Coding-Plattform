/**
 * The environment of a shell or command that runs in the USER's project. When the app itself was
 * started through a package manager (e.g. `pnpm dev` while developing it), npm/pnpm put their own
 * context into the environment: npm_config_* / pnpm_* variables, the script's working directory and
 * the app's node_modules/.bin folders on PATH. Inherited by a project terminal, that context makes
 * `pnpm install` behave as if the project were part of the app's workspace ("Scope: all … workspace
 * projects") instead of installing the project.
 */
export function withoutPackageManagerContext(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (/^(npm_|pnpm_|PNPM_|YARN_|BERRY_)/i.test(key) || key === 'INIT_CWD' || key === 'NODE') continue
    env[key] = value
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  if (pathKey) {
    const separator = env[pathKey]!.includes(';') ? ';' : ':'
    env[pathKey] = env[pathKey]!.split(separator)
      .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(entry) && !/[\\/]node-gyp-bin[\\/]?$/i.test(entry))
      .join(separator)
  }
  return env
}
