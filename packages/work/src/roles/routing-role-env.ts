/** Environment sent to a routed workflow process. Only public stage custody
 * remains; no account-store selector, credential command, or operator HOME. */
export function routedWorkerEnv(
  ambient: Record<string, string | undefined>,
  publicStage: { HOME: string; OWENLOOP_CONFIG_DIR: string },
): Record<string, string | undefined> {
  const result = { ...ambient };
  for (const key of Object.keys(result)) {
    if (key.startsWith('OWENLOOP_') || key === 'USERPROFILE'
      || key === 'XDG_CONFIG_HOME' || key === 'XDG_DATA_HOME') delete result[key];
  }
  result.HOME = publicStage.HOME;
  result.OWENLOOP_CONFIG_DIR = publicStage.OWENLOOP_CONFIG_DIR;
  return result;
}
