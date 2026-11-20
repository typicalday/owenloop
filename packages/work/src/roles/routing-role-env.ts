/** Environment sent to a routed workflow process. Only public stage custody
 * remains; no account-store selector, credential command, or operator HOME. */
import { isAbsolute } from 'node:path';

export function routedWorkerEnv(
  ambient: Record<string, string | undefined>,
  publicStage: { HOME: string; OWENLOOP_CONFIG_DIR: string },
): Record<string, string | undefined> {
  if (!isAbsolute(publicStage.HOME) || !isAbsolute(publicStage.OWENLOOP_CONFIG_DIR))
    throw new Error('routing worker environment refused');
  const result = { ...ambient };
  for (const key of Object.keys(result)) {
    if (key.startsWith('OWENLOOP_') || key === 'USERPROFILE'
      || key === 'XDG_CONFIG_HOME' || key === 'XDG_DATA_HOME') delete result[key];
  }
  result.HOME = publicStage.HOME;
  result.USERPROFILE = publicStage.HOME;
  result.OWENLOOP_CONFIG_DIR = publicStage.OWENLOOP_CONFIG_DIR;
  // macOS selects the login Keychain before the public file store unless this
  // is explicit. A nested CLI must never recover the operator's Hub bearer.
  result.OWENLOOP_NO_KEYCHAIN = '1';
  return result;
}
