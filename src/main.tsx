import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

// no StrictMode: its double-mounted effects would create two WebGL renderers on one canvas
createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.DEV) void import('./dev/qa');
