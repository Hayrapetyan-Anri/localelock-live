import { getConfig } from '../config.js';

export type WorkerPayload = { type: 'run_release_gate'; run_id: string } | { type: 'seed'; force?: boolean };

export async function enqueueWorker(payload: WorkerPayload): Promise<{ mode: 'lambda' | 'local' }> {
  const cfg = await getConfig();
  if (cfg.mode === 'lambda') {
    if (!cfg.workerFunctionName) throw new Error('WORKER_FUNCTION_NAME is not set');
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const client = new LambdaClient({});
    await client.send(new InvokeCommand({ FunctionName: cfg.workerFunctionName, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
    return { mode: 'lambda' };
  }
  setImmediate(() => {
    import('./worker.js')
      .then((m) => m.handler(payload))
      .catch((err) => console.error('[worker] unhandled', (err as Error).stack ?? err));
  });
  return { mode: 'local' };
}
