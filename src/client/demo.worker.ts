import { createDemoSession } from './demo-session';

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
};
const session = createDemoSession({ now: () => Date.now(), emit: message => scope.postMessage(message) });
const timer = setInterval(() => session.tick(), 50);
scope.onmessage = event => {
  if (event.data?.type === 'dispose') {
    clearInterval(timer); session.close(); scope.close();
  } else if (event.data?.type === 'release_input') session.releaseInput();
  else session.receive(event.data);
};
