import {
  ASK_OPEN_PROMPT,
  buildAskAgentSession,
  fallbackAskChatReply,
  fallbackOptionsFromFacts,
  parseAskChatLlmJson,
  parseAskOptionPayload,
  resolveAskOptionParams,
  sanitizeLlmOptions,
} from './ask-agent';
import type { ApplyPrefill } from './auto-fix';

const basePrefill: ApplyPrefill = {
  container: 'web',
  currentImage: 'opspilot.invalid/does-not-exist:latest',
  newImage: '',
  memoryLimit: '16Mi',
  memoryRequest: '16Mi',
  suggestedMemoryLimit: '512Mi',
  desiredReplicas: '1',
  source: 'cluster',
};

describe('ask-agent', () => {
  it('builds facts without hardcoded chips', () => {
    const session = buildAskAgentSession(
      {
        type: 'OOMKilled',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-b',
        suggestedFix: 'Raise memory',
      },
      basePrefill,
    );
    expect(session.options).toEqual([]);
    expect(session.problem).toMatch(/OOMKilled/);
    expect(session.facts).toMatch(/memoryLimit=16Mi/);
  });

  it('builds docker container session for Ask Pulse', () => {
    const session = buildAskAgentSession(
      {
        type: 'ContainerExited',
        message: 'Container backend exited with code 255',
        resource: 'container/backend',
        metadata: {
          source: 'docker',
          host: 'mac',
          image: 'python:3.11-slim',
          exitCode: '255',
        },
      },
      { ...basePrefill, currentImage: 'python:3.11-slim' },
    );
    expect(session.platform).toBe('docker');
    expect(session.namespace).toBe('mac');
    expect(session.deployment).toBe('backend');
    expect(session.problem).toMatch(/Docker host mac/);
    expect(fallbackOptionsFromFacts(session).length).toBeGreaterThan(0);
  });

  it('sanitizes LLM chips to allowlisted actions only', () => {
    const opts = sanitizeLlmOptions(
      [
        {
          action: 'set_memory',
          label: 'Raise memory to 256Mi',
          detail: 'Current limit is 16Mi.',
          memoryLimit: '256Mi',
        },
        { action: 'rm_cluster', label: 'Delete everything' },
        { action: 'set_image', label: 'Set nginx', image: 'nginx:1.27-alpine' },
      ],
      basePrefill,
    );
    expect(opts.map((o) => o.action)).toEqual(['set_memory', 'set_image']);
    expect(opts[0].params.memoryLimit).toBe('256Mi');
    expect(opts[1].params.image).toBe('nginx:1.27-alpine');
  });

  it('resolves custom image input into enqueue params', () => {
    const [opt] = sanitizeLlmOptions(
      [{ action: 'set_image', label: 'Custom image', needsInput: true }],
      basePrefill,
    );
    const params = resolveAskOptionParams(opt, 'nginx:1.27-alpine');
    expect(params.image).toBe('nginx:1.27-alpine');
    expect(params.acknowledge).toBe('1');
  });

  it('parses LLM JSON options and ignores illegal propose ids', () => {
    const parsed = parseAskChatLlmJson(
      JSON.stringify({
        reply: 'The pod is OOM-killed because the limit is 16Mi.',
        options: [
          {
            action: 'set_memory',
            label: 'Raise memory to 256Mi',
            memoryLimit: '256Mi',
          },
        ],
        propose: null,
      }),
      basePrefill,
    );
    expect(parsed?.options).toHaveLength(1);
    expect(parsed?.options[0].label).toMatch(/256Mi/);
    const bad = parseAskChatLlmJson(
      '{"reply":"nope","propose":{"optionId":"rm_cluster"},"options":[]}',
      basePrefill,
    );
    expect(bad?.propose).toBeNull();
  });

  it('applies a posted LLM option payload', () => {
    const opt = parseAskOptionPayload(
      {
        option: {
          action: 'set_memory',
          label: 'Raise memory to 256Mi',
          memoryLimit: '256Mi',
        },
      },
      [],
      basePrefill,
    );
    const params = resolveAskOptionParams(opt);
    expect(params.memoryLimit).toBe('256Mi');
  });

  it('answers what-is-the-issue without demanding a chip pick', () => {
    const session = buildAskAgentSession(
      {
        type: 'ImagePullBackOff',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-a',
        suggestedFix: 'Fix image',
      },
      basePrefill,
    );
    const r = fallbackAskChatReply(session, 'what its the issue');
    expect(r.reply.toLowerCase()).toMatch(/imagepull|failing|cannot pull|can't pull|image/);
    expect(r.propose).toBeNull();
    expect(r.options[0].action).toBe('set_image');
    expect(r.reply.toLowerCase()).not.toMatch(/pick one of the suggested/);
  });

  it('offers memory chips for OOM when the model is down', () => {
    const session = buildAskAgentSession(
      {
        type: 'OOMKilled',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-b',
        suggestedFix: 'Raise memory',
      },
      basePrefill,
    );
    const r = fallbackAskChatReply(session, ASK_OPEN_PROMPT);
    expect(r.options.some((o) => o.action === 'set_memory')).toBe(true);
    expect(r.reply.toLowerCase()).toMatch(/memory|oom|137/);
  });

  it('quotes the missing Secret name from kube waitingMessage', () => {
    const session = buildAskAgentSession(
      {
        type: 'CreateContainerConfigError',
        namespace: 'opspilot-demo',
        resource: 'pod/demo-healthy-c-abc',
        message: 'secret "opspilot-missing-secret" not found',
        metadata: {
          waitingMessage: 'secret "opspilot-missing-secret" not found',
        },
      },
      basePrefill,
    );
    expect(session.facts).toMatch(/opspilot-missing-secret/);
    const r = fallbackAskChatReply(session, ASK_OPEN_PROMPT);
    expect(r.reply).toMatch(/opspilot-missing-secret/);
    expect(r.reply.toLowerCase()).toMatch(/secret/);
  });

  it('includes live cluster inspect when the model is down', () => {
    const session = buildAskAgentSession(
      {
        type: 'OOMKilled',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-b',
      },
      basePrefill,
    );
    const r = fallbackAskChatReply(
      session,
      ASK_OPEN_PROMPT,
      'waitingReason=OOMKilled\nmemoryLimit=16Mi',
    );
    expect(r.reply).toMatch(/Live cluster inspect/);
    expect(r.reply).toMatch(/OOMKilled/);
    expect(r.propose).toBeNull();
  });

  it('answers what-secret on an OOM chat without repeating the OOM essay', () => {
    const session = buildAskAgentSession(
      {
        type: 'OOMKilled',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-b',
        message: 'container app terminated: OOMKilled (exit 137)',
      },
      basePrefill,
    );
    const r = fallbackAskChatReply(
      session,
      'what secret',
      'Warning Failed pod/demo-healthy-c-844746d444-rsskc Error: secret "opspilot-missing-secret" not found',
    );
    expect(r.reply).toMatch(/opspilot-missing-secret/);
    expect(r.reply.toLowerCase()).toMatch(/not this incident|another pod/);
    expect(r.reply).not.toMatch(/kernel killed the container/);
  });

  it('quotes the missing Secret when that is this incident', () => {
    const session = buildAskAgentSession(
      {
        type: 'CreateContainerConfigError',
        namespace: 'opspilot-demo',
        resource: 'deployment/demo-healthy-c',
        message: 'secret "opspilot-missing-secret" not found',
        metadata: {
          waitingMessage: 'secret "opspilot-missing-secret" not found',
        },
      },
      basePrefill,
    );
    const r = fallbackAskChatReply(session, 'what secret');
    expect(r.reply).toMatch(/opspilot-missing-secret/);
    expect(r.reply.toLowerCase()).toMatch(/missing/);
  });

  it('exposes an analyze opener prompt', () => {
    expect(ASK_OPEN_PROMPT.toLowerCase()).toMatch(/analyze/);
  });
});
