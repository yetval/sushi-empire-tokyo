import './ui/styles.css';
import { Game } from './game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
try {
  (window as any).game = new Game(canvas);
} catch (e) {
  console.error(e);
  document.body.innerHTML = `<div style="font:20px sans-serif;padding:40px;color:#fff;background:#222;height:100vh">
    Sushi Empire: Tokyo needs WebGL. Please use an up-to-date Chrome, Edge, Firefox or Safari.<br><small>${String(e)}</small></div>`;
}
