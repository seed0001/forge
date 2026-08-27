import { createRoot } from 'react-dom/client';
import { OverlayApp } from './components/OverlayApp';
import './overlay.css';

createRoot(document.getElementById('orb-root')!).render(<OverlayApp />);
