import {createRoot} from 'react-dom/client';
import App from '../App.tsx';

// Actual App/EventCenter/pick listener; HTTP, WS and microphone are substituted by the test.
createRoot(document.getElementById('root')!).render(<App/>);
