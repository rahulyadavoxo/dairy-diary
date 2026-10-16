import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { applyListAnim } from './listAnim.js';

applyListAnim();

createRoot(document.getElementById('root')).render(<App />);
