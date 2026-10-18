import { TaskQueueService } from '../src/content/services/task-queue.service';

describe('TaskQueueService', () => {
  it('creates stable, normalized source fingerprints', () => {
    const service = new TaskQueueService({} as never, {} as never);
    expect(service.fingerprint(' HTTPS://EXAMPLE.COM/A ', ' Same Title ')).toBe(
      service.fingerprint('https://example.com/a', 'same title'),
    );
  });

  it('separates different sources', () => {
    const service = new TaskQueueService({} as never, {} as never);
    expect(service.fingerprint('https://example.com/a', 'Title')).not.toBe(
      service.fingerprint('https://example.com/b', 'Title'),
    );
  });
});
