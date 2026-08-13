import {
  buildAutoFixCommands,
  buildAgentFixPlan,
  getSuggestionAction,
  hasUsableSuggestion,
  mergeClusterPrefill,
  resolveApplyPrefill,
  splitCommands,
} from './auto-fix';

describe('auto-fix', () => {
  describe('getSuggestionAction', () => {
    it('returns apply for OOMKilled with deployment target + suggestion', () => {
      expect(
        getSuggestionAction({
          type: 'OOMKilled',
          resource: 'pod/demo-oom-abc123456-xyz12',
          suggestedFix: 'Raise the container memory limit.',
        }),
      ).toBe('apply');
    });

    it('returns apply for ImagePullBackOff with deployment target + suggestion', () => {
      expect(
        getSuggestionAction({
          type: 'ImagePullBackOff',
          resource: 'deployment/demo-imagepull',
          suggestedFix: 'Fix the image tag and pull secret.',
        }),
      ).toBe('apply');
    });

    it('returns apply for DeploymentUnhealthy with deployment target + suggestion', () => {
      expect(
        getSuggestionAction({
          type: 'DeploymentUnhealthy',
          resource: 'deployment/demo-exit2',
          suggestedFix: 'Check pod readiness failures.',
        }),
      ).toBe('apply');
    });

    it('returns view for CrashLoop advice (not silent apply)', () => {
      expect(
        getSuggestionAction({
          type: 'CrashLoopBackOff',
          resource: 'pod/demo-exit2-58dd656bcd-vsd69',
          suggestedFix: 'Check DB connectivity from the pod.',
        }),
      ).toBe('view');
    });

    it('returns view for KubernetesWarning when suggestion exists', () => {
      expect(
        getSuggestionAction({
          type: 'KubernetesWarning',
          suggestedFix: 'Investigate associated CrashLoop.',
        }),
      ).toBe('view');
    });

    it('returns null without usable suggestion', () => {
      expect(
        getSuggestionAction({
          type: 'OOMKilled',
          resource: 'deployment/demo-oom',
          suggestedFix: null,
        }),
      ).toBeNull();
      expect(
        getSuggestionAction({
          type: 'OOMKilled',
          resource: 'deployment/demo-oom',
          suggestedFix: 'Generating suggestion…',
        }),
      ).toBeNull();
    });

    it('downgrades OOM to view when no deployment target', () => {
      expect(
        getSuggestionAction({
          type: 'OOMKilled',
          resource: null,
          suggestedFix: 'Raise memory.',
        }),
      ).toBe('view');
    });
  });

  describe('hasUsableSuggestion', () => {
    it('rejects placeholders', () => {
      expect(hasUsableSuggestion('')).toBe(false);
      expect(hasUsableSuggestion('Generating…')).toBe(false);
    });
  });

  describe('buildAutoFixCommands', () => {
    it('tags OOM mutate as apply and inspect as dry-run', () => {
      const cmds = buildAutoFixCommands({
        type: 'OOMKilled',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-oom-abc123456-xyz12',
        suggestedFix: 'Raise memory',
      });
      const { dryRun, apply } = splitCommands(cmds);
      expect(dryRun.length).toBeGreaterThan(0);
      expect(apply.some((c) => c.command.includes('set resources'))).toBe(true);
    });

    it('does not include rollout restart as apply for CrashLoop', () => {
      const cmds = buildAutoFixCommands({
        type: 'CrashLoopBackOff',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-exit2-58dd656bcd-vsd69',
        suggestedFix: 'Inspect logs',
      });
      const { apply } = splitCommands(cmds);
      expect(apply).toEqual([]);
      expect(cmds.some((c) => c.command.includes('logs'))).toBe(true);
    });
  });

  describe('resolveApplyPrefill', () => {
    it('reads container and image from snapshot', () => {
      const p = resolveApplyPrefill({
        type: 'ImagePullBackOff',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-imagepull-abc123456-xyz12',
        suggestedFix: 'Fix image',
        snapshot: {
          container: {
            name: 'bad-image',
            image: 'opspilot.invalid/does-not-exist:latest',
          },
        },
      });
      expect(p.container).toBe('bad-image');
      expect(p.currentImage).toBe('opspilot.invalid/does-not-exist:latest');
      expect(p.source).toBe('snapshot');
      expect(p.newImage).toBe('');
    });

    it('suggests a memory bump from current limit', () => {
      const p = resolveApplyPrefill({
        type: 'OOMKilled',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-oom',
        suggestedFix: 'Raise memory',
        metadata: {
          container: 'hog',
          memoryLimit: '16Mi',
          memoryRequest: '16Mi',
        },
      });
      expect(p.container).toBe('hog');
      expect(p.memoryLimit).toBe('16Mi');
      expect(p.suggestedMemoryLimit).toBe('256Mi');
      expect(p.source).toBe('metadata');
    });

    it('mergeClusterPrefill prefers live cluster values', () => {
      const base = resolveApplyPrefill({
        type: 'ImagePullBackOff',
        suggestedFix: 'fix',
        metadata: { container: 'old', image: 'old:1' },
      });
      const merged = mergeClusterPrefill(base, {
        container: 'bad-image',
        image: 'nginx:alpine',
      });
      expect(merged.container).toBe('bad-image');
      expect(merged.currentImage).toBe('nginx:alpine');
      expect(merged.source).toBe('cluster');
    });
  });

  describe('buildAgentFixPlan', () => {
    it('builds set_deployment_memory for OOM with chosen limit', () => {
      const plan = buildAgentFixPlan(
        {
          type: 'OOMKilled',
          namespace: 'opspilot-demo',
          resource: 'pod/demo-oom-abc123456-xyz12',
          suggestedFix: 'Raise memory',
          metadata: { container: 'hog' },
        },
        { memoryLimit: '1Gi', container: 'hog' },
      );
      expect(plan.type).toBe('set_deployment_memory');
      expect(plan.params.memoryLimit).toBe('1Gi');
      expect(plan.params.deployment).toBe('demo-oom');
    });

    it('rejects invalid memory', () => {
      expect(() =>
        buildAgentFixPlan(
          {
            type: 'OOMKilled',
            namespace: 'opspilot-demo',
            resource: 'deployment/demo-oom',
            suggestedFix: 'Raise memory',
          },
          { memoryLimit: 'lots', container: 'oom' },
        ),
      ).toThrow(/Invalid memory/);
    });

    it('builds set_deployment_image for ImagePull', () => {
      const plan = buildAgentFixPlan(
        {
          type: 'ImagePullBackOff',
          namespace: 'opspilot-demo',
          resource: 'deployment/demo-imagepull',
          suggestedFix: 'Fix image',
        },
        { image: 'nginx:alpine', container: 'bad-image' },
      );
      expect(plan.type).toBe('set_deployment_image');
      expect(plan.params.image).toBe('nginx:alpine');
    });

    it('builds restart_deployment for DeploymentUnhealthy', () => {
      const plan = buildAgentFixPlan(
        {
          type: 'DeploymentUnhealthy',
          namespace: 'opspilot-demo',
          resource: 'deployment/demo-exit2',
          suggestedFix: 'Check pods',
        },
        { deployAction: 'restart' },
      );
      expect(plan.type).toBe('restart_deployment');
      expect(plan.params.deployment).toBe('demo-exit2');
    });

    it('builds scale_deployment for DeploymentUnhealthy', () => {
      const plan = buildAgentFixPlan(
        {
          type: 'DeploymentUnhealthy',
          namespace: 'opspilot-demo',
          resource: 'deployment/demo-exit2',
          suggestedFix: 'Check pods',
        },
        { deployAction: 'scale', replicas: '2' },
      );
      expect(plan.type).toBe('scale_deployment');
      expect(plan.params.replicas).toBe('2');
    });
  });
});
