import { app } from 'electron'
import path from 'node:path'

/** Resolves bundled resources in development (repo layout) and in the packaged app. */
export function resourcePaths() {
  const appPath = app.getAppPath()
  if (app.isPackaged) {
    return {
      backendEntry: path.join(appPath, 'backend', 'main.cjs'),
      migrationsDir: path.join(appPath, 'backend', 'migrations'),
      rendererDir: path.join(appPath, 'dist', 'renderer'),
      preload: path.join(appPath, 'dist', 'preload', 'preload.cjs'),
      icon: path.join(appPath, 'build', 'icon.png'),
    }
  }
  return {
    backendEntry: path.join(appPath, 'dist', 'backend', 'main.cjs'),
    migrationsDir: path.resolve(appPath, '..', '..', 'prisma', 'migrations'),
    rendererDir: path.join(appPath, 'dist', 'renderer'),
    preload: path.join(appPath, 'dist', 'preload', 'preload.cjs'),
    icon: path.join(appPath, 'build', 'icon.png'),
  }
}
