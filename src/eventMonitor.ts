export default class EventMonitor {
  async getCurrentBlockNumber(_chainId: number): Promise<number> {
    return 0;
  }

  async checkEventTriggers(_workflow: any, _db: any) {
    return { hasEvents: true, results: [] as any[] };
  }
} 