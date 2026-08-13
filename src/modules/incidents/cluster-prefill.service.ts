import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type LiveContainerPrefill = {
  container: string;
  image: string;
  memoryLimit: string;
  memoryRequest: string;
  replicas: string;
};

/**
 * Best-effort live sniff from the lab cluster via kubectl.
 * Production SaaS should rely on agent snapshot/metadata; this is a lab fallback.
 */
@Injectable()
export class ClusterPrefillService {
  private readonly logger = new Logger(ClusterPrefillService.name);

  async sniffDeploymentContainer(
    namespace: string,
    deployment: string,
    preferredContainer?: string,
  ): Promise<LiveContainerPrefill | null> {
    const ns = (namespace || '').trim();
    const deploy = (deployment || '').trim();
    if (!ns || !deploy) return null;

    const context =
      process.env.KUBE_CONTEXT ||
      process.env.OPSPILOT_KUBE_CONTEXT ||
      'kind-opspilot-lab';

    try {
      const { stdout } = await execFileAsync(
        'kubectl',
        [
          '--context',
          context,
          '-n',
          ns,
          'get',
          'deploy',
          deploy,
          '-o',
          'json',
        ],
        { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const doc = JSON.parse(stdout) as {
        spec?: {
          replicas?: number;
          template?: {
            spec?: {
              containers?: Array<{
                name?: string;
                image?: string;
                resources?: {
                  limits?: { memory?: string };
                  requests?: { memory?: string };
                };
              }>;
            };
          };
        };
      };
      const containers = doc?.spec?.template?.spec?.containers || [];
      if (!containers.length) return null;

      const match =
        (preferredContainer &&
          containers.find((c) => c.name === preferredContainer)) ||
        containers[0];

      return {
        container: String(match.name || ''),
        image: String(match.image || ''),
        memoryLimit: String(match.resources?.limits?.memory || ''),
        memoryRequest: String(match.resources?.requests?.memory || ''),
        replicas:
          doc.spec?.replicas !== undefined && doc.spec?.replicas !== null
            ? String(doc.spec.replicas)
            : '',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`cluster prefill skipped: ${msg}`);
      return null;
    }
  }
}
