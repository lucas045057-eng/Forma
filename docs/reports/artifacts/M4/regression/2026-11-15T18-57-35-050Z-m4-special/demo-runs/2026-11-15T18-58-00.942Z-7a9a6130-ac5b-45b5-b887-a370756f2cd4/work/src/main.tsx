import { createRoot } from 'react-dom/client';
import { installBridge } from '@spatial/bridge';
import App from './App';
import './style.css';

if (import.meta.env.DEV) {
  const dispose = installBridge();
  import.meta.hot?.dispose(dispose);
}
createRoot(document.getElementById('root')!).render(<App/>);
