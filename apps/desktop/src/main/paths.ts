import { app } from 'electron'
import path from 'node:path'

/** Resolves bundled resources in development (repo layout) and in the packaged app. */
export function resourcePaths() {
  const appPath = app.getAppPath()
  if (app.isPackaged) {
    return {
      backendEntry: path.join(appPath, 'backend', 'boot.cjs'),
      migrationsDir: path.join(appPath, 'backend', 'migrations'),
      pluginsDir: path.join(appPath, 'plugins'),
      skillsDir: path.join(appPath, 'skills'),
      rendererDir: path.join(appPath, 'dist', 'renderer'),
      preload: path.join(appPath, 'dist', 'preload', 'preload.cjs'),
      icon: path.join(appPath, 'build', 'icon.png'),
    }
  }
  return {
    backendEntry: path.join(appPath, 'dist', 'backend', 'boot.cjs'),
    migrationsDir: path.resolve(appPath, '..', '..', 'prisma', 'migrations'),
    pluginsDir: path.resolve(appPath, '..', '..', 'plugins'),
    skillsDir: path.resolve(appPath, '..', '..', 'skills'),
    rendererDir: path.join(appPath, 'dist', 'renderer'),
    preload: path.join(appPath, 'dist', 'preload', 'preload.cjs'),
    icon: path.join(appPath, 'build', 'icon.png'),
  }
}
