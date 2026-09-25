import React from 'react';
import { createRoot } from 'react-dom/client';
import { useDemo } from './useDemo';
import { DemoView } from './DemoView';
import './styles.css';

function App() {
  const model = useDemo();
  return <DemoView model={model} />;
}

const root = createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
