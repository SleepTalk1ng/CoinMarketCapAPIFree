import { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

export interface ShutdownOptions {
  readonly signals?: {
    on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  };
  readonly terminate?: (code: number) => void;
}

export function installShutdown(
  server: Server,
  database: { close(): Promise<void> },
  job: { stop(): Promise<void> },
  quotes: { stop(): Promise<void> },
  timeoutMs: number,
  options: ShutdownOptions = {},
): { stop(): Promise<void>; readonly stopping: boolean } {
  const signals = options.signals ?? process;
  const terminate = options.terminate ?? ((code: number) => process.exit(code));
  // Sockets and pending operations are lifecycle state, not a coin/history cache.
  const sockets = new Set<Socket>();
  const activeResponses = new Map<Socket, number>();
  const connection = (socket: Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', connection);
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let databaseClose: Promise<void> | undefined;
  const request = (incoming: IncomingMessage, response: ServerResponse): void => {
    const socket = incoming.socket;
    activeResponses.set(socket, (activeResponses.get(socket) ?? 0) + 1);
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      const remaining = (activeResponses.get(socket) ?? 1) - 1;
      if (remaining > 0) activeResponses.set(socket, remaining);
      else {
        activeResponses.delete(socket);
        if (stopping) socket.end();
      }
    };
    response.once('finish', complete);
    response.once('close', complete);
  };
  server.prependListener('request', request);
  const closeDatabase = (): Promise<void> => databaseClose ??= database.close();
  const failure = (): void => {
    console.error('Server shutdown failed.');
    process.exitCode = 1;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error('Server shutdown timed out.');
      process.exitCode = 1;
      for (const socket of sockets) socket.destroy();
      // close() drains accepted SQLite work; hard exit is only the deadline fallback.
      void closeDatabase().catch(failure);
      terminate(1);
    }, timeoutMs);
    const httpClosed = new Promise<void>((resolveClosed, reject) => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolveClosed();
      });
      // Node 18 does not automatically close all idle keep-alive connections.
      server.closeIdleConnections?.();
      for (const socket of sockets) if (!activeResponses.has(socket)) socket.end();
    });
    stopPromise = (async () => {
      const results = await Promise.allSettled([httpClosed, job.stop(), quotes.stop()]);
      if (results.some(result => result.status === 'rejected')) failure();
      await closeDatabase();
    })().catch(failure).finally(() => {
      clearTimeout(deadline);
      signals.removeListener('SIGINT', signal);
      signals.removeListener('SIGTERM', signal);
      server.removeListener('connection', connection);
      server.removeListener('request', request);
      server.removeListener('close', closed);
    });
    return stopPromise;
  };
  const signal = (): void => { void stop(); };
  const closed = (): void => { void stop(); };
  signals.on('SIGINT', signal);
  signals.on('SIGTERM', signal);
  server.once('close', closed);
  return { stop, get stopping() { return stopping; } };
}
