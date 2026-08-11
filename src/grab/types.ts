import type { HostClient } from '../host-client';

/** Narrowest slice of `HostClient` every grab/completion module needs — lets
 *  tests inject a fake without standing up a real socket. */
export type HostCaller = Pick<HostClient, 'call'>;
