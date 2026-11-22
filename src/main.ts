import { done, fail, fontsReady, step, webglSupported } from './boot/boot';
import './ui/styles.css';
import { Game } from './game';

// The <canvas id="game"> is also exposed as window.game; shadow it so `window.game` means the Game once it exists.
(window as any).game = null;

async function start(): Promise<void> {
  if (!webglSupported()) { fail(); return; }
  await step(65, 'Loading fonts…', fontsReady(), 3000);
  await step(85, 'Building Tokyo…');
  try {
    (window as any).game = new Game(document.getElementById('game') as HTMLCanvasElement);
  } catch (e) {
    console.error(e);
    fail(e);
    return;
  }
  done();
}
void start();
