import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const service = {
    on: vi.fn(),
    stop: vi.fn((callback?: () => void) => callback?.()),
  };
  const bonjour = {
    publish: vi.fn(() => service),
    destroy: vi.fn(),
  };

  return {
    service,
    bonjour,
    Bonjour: vi.fn(function BonjourMock() {
      return bonjour;
    }),
  };
});

vi.mock('bonjour-service', () => ({
  Bonjour: mocks.Bonjour,
}));

vi.mock('../../../server/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    warn: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('node:os', () => ({
  default: {
    hostname: vi.fn(() => 'test-hostname'),
  },
}));

const { MDNSService } = await import('../../../server/services/mdns-service');

describe('MDNSService', () => {
  let service: InstanceType<typeof MDNSService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bonjour.publish.mockReturnValue(mocks.service);
    service = new MDNSService();
  });

  afterEach(async () => {
    await service.stopAdvertising();
  });

  it('constructs Bonjour and advertises the Untether service', async () => {
    await service.startAdvertising(4020);

    expect(mocks.Bonjour).toHaveBeenCalledOnce();
    expect(mocks.bonjour.publish).toHaveBeenCalledWith({
      name: 'test-hostname',
      type: 'untether',
      port: 4020,
      txt: {
        version: '1.0',
        platform: process.platform,
      },
    });
    expect(mocks.service.on).toHaveBeenCalledWith('up', expect.any(Function));
    expect(mocks.service.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(service.isActive()).toBe(true);
  });

  it('passes an error callback so a failed multicast send never throws', async () => {
    await service.startAdvertising(4020);

    const errorCallback = (mocks.Bonjour.mock.calls[0] as unknown[])[1] as (e: Error) => void;
    expect(errorCallback).toEqual(expect.any(Function));
    expect(() => errorCallback(new Error('send EHOSTUNREACH 224.0.0.251:5353'))).not.toThrow();
  });

  it('stops the published service and destroys Bonjour', async () => {
    await service.startAdvertising(4020);
    await service.stopAdvertising();

    expect(mocks.service.stop).toHaveBeenCalledOnce();
    expect(mocks.bonjour.destroy).toHaveBeenCalledOnce();
    expect(service.isActive()).toBe(false);
  });

  it('does not publish twice while already active', async () => {
    await service.startAdvertising(4020);
    await service.startAdvertising(4021);

    expect(mocks.Bonjour).toHaveBeenCalledOnce();
    expect(mocks.bonjour.publish).toHaveBeenCalledOnce();
  });
});
